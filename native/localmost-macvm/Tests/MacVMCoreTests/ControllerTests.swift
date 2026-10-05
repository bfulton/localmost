import XCTest
@testable import MacVMCore

/// A VM that does what the test says, when it says.
final class FakeMachine: Machine {
    var onStop: ((MachineStopCause) -> Void)?
    var calls: [String] = []
    var startDone: ((Error?) -> Void)?
    var restoreDone: ((Error?) -> Void)?
    var saveDone: ((Error?) -> Void)?
    var stopDone: ((Error?) -> Void)?
    var canRequest = true

    func start(_ done: @escaping (Error?) -> Void) {
        calls.append("start")
        startDone = done
    }

    func restore(from path: String, _ done: @escaping (Error?) -> Void) {
        calls.append("restore \((path as NSString).lastPathComponent)")
        restoreDone = done
    }

    func pauseAndSave(to path: String, _ done: @escaping (Error?) -> Void) {
        calls.append("save \((path as NSString).lastPathComponent)")
        saveDone = done
    }

    func requestStop() -> Bool {
        calls.append("requestStop")
        return canRequest
    }

    func forceStop(_ done: @escaping (Error?) -> Void) {
        calls.append("forceStop")
        stopDone = done
        done(nil)
    }
}

final class ControllerTests: XCTestCase {
    private var machine: FakeMachine!
    private var rec: Recorder!
    private var timers: [(Int, () -> Void)] = []
    private var controller: Controller!

    override func setUp() {
        machine = FakeMachine()
        rec = Recorder()
        timers = []
        controller = Controller(machine: machine, hooks: ControllerHooks(hooks: rec.hooks, startMs: { 42 }, after: { [unowned self] ms, block in
            self.timers.append((ms, block))
        }))
    }

    private func command(_ json: String) {
        controller.handle(.line(Data(json.utf8)))
    }

    func testAColdBootReportsStartedWithItsBoot() {
        controller.begin(.cold, startedFields: ["mac": "02:00:00:00:00:01"])
        XCTAssertEqual(machine.calls, ["start"])
        XCTAssertTrue(rec.named("started").isEmpty)
        machine.startDone?(nil)
        let started = rec.named("started").first
        XCTAssertEqual(started?["boot"] as? String, "cold")
        XCTAssertEqual(started?["startMs"] as? Int, 42)
        XCTAssertEqual(started?["mac"] as? String, "02:00:00:00:00:01")
        XCTAssertEqual(controller.booted, "cold")
    }

    func testARestoredStateIsUsedWhenVZTakesIt() {
        controller.begin(.restore("/x/state.vzvmsave"))
        XCTAssertEqual(machine.calls, ["restore state.vzvmsave"])
        machine.restoreDone?(nil)
        XCTAssertEqual(rec.named("started").first?["boot"] as? String, "restore")
    }

    func testARefusedStateFallsBackToAColdBoot() {
        controller.begin(.restore("/x/state.vzvmsave"))
        machine.restoreDone?(NSError(domain: "VZErrorDomain", code: 12))
        XCTAssertEqual(machine.calls, ["restore state.vzvmsave", "start"])
        XCTAssertEqual(rec.named("restore").first?["ok"] as? Bool, false)
        machine.startDone?(nil)
        XCTAssertEqual(rec.named("started").first?["boot"] as? String, "cold")
        XCTAssertNil(rec.exitCode)
    }

    func testAFailedStartEndsWithItsCode() {
        controller.begin(.cold)
        machine.startDone?(NSError(domain: "VZErrorDomain", code: 2))
        XCTAssertEqual(rec.last["event"] as? String, "end")
        XCTAssertEqual(rec.last["code"] as? String, "E_VZ_START")
        XCTAssertEqual(rec.exitCode, ErrorCode.vzStart.exitCode)
    }

    func testAPreStartFailureNeverStartsTheVM() {
        controller.begin(.cold, preStart: { throw HelperError(.image, "gone") })
        XCTAssertEqual(machine.calls, [])
        XCTAssertEqual(rec.last["code"] as? String, "E_IMAGE")
    }

    func testOnRunningRunsBeforeStartedIsSent() {
        var sawStarted: Bool?
        controller.begin(.cold, onRunning: { [unowned self] in sawStarted = !self.rec.named("started").isEmpty })
        machine.startDone?(nil)
        XCTAssertEqual(sawStarted, false)
    }

    func testAStopWithGraceAsksTheGuestFirst() {
        controller.begin(.cold)
        machine.startDone?(nil)
        command(#"{"v":1,"id":7,"op":"stop","graceMs":5000}"#)
        XCTAssertEqual(rec.events.first { $0["id"] as? Int == 7 }?["ok"] as? Bool, true)
        XCTAssertEqual(machine.calls, ["start", "requestStop"])
        XCTAssertEqual(timers.map { $0.0 }, [5000])
        machine.onStop?(.guest)
        XCTAssertEqual(rec.last["reason"] as? String, "requested", "a power-off this side asked for is requested")
        XCTAssertEqual(rec.exitCode, 0)
    }

    func testAStopWhoseGraceRunsOutForcesIt() {
        controller.begin(.cold)
        machine.startDone?(nil)
        command(#"{"v":1,"id":1,"op":"stop","graceMs":100}"#)
        timers.first?.1()
        XCTAssertEqual(machine.calls, ["start", "requestStop", "forceStop"])
        XCTAssertEqual(rec.last["reason"] as? String, "requested")
    }

    func testTheGuestPoweringOffEndsIt() {
        controller.begin(.cold)
        machine.startDone?(nil)
        machine.onStop?(.guest)
        XCTAssertEqual(rec.last["reason"] as? String, "guest")
        XCTAssertEqual(rec.exitCode, 0)
    }

    func testAVZErrorEndsIt() {
        controller.begin(.cold)
        machine.startDone?(nil)
        machine.onStop?(.error("the guest crashed"))
        XCTAssertEqual(rec.last["code"] as? String, "E_GUEST_ERROR")
    }

    func testTheParentGoingStopsAtOnce() {
        controller.begin(.cold)
        machine.startDone?(nil)
        controller.parentGone()
        XCTAssertEqual(machine.calls, ["start", "forceStop"])
        XCTAssertEqual(rec.exitCode, 0)
    }

    func testAStopDuringStartIsCarriedOutOnceStarted() {
        controller.begin(.cold)
        controller.signalled("SIGTERM")
        XCTAssertEqual(timers.map { $0.0 }, [startStopDeadlineMs])
        machine.startDone?(nil)
        XCTAssertEqual(machine.calls, ["start", "forceStop"])
        XCTAssertEqual(rec.last["reason"] as? String, "requested")
    }

    func testAStartThatNeverFinishesIsAbandoned() {
        controller.begin(.cold)
        controller.inputClosed()
        timers.first?.1()
        XCTAssertEqual(rec.last["reason"] as? String, "requested")
        XCTAssertEqual(rec.exitCode, 0)
        machine.startDone?(nil)
        XCTAssertTrue(rec.named("started").isEmpty, "a start after the end is ignored")
    }

    func testAStopDuringARefusedRestoreDoesNotBootCold() {
        controller.begin(.restore("/x/s.vzvmsave"))
        controller.signalled("SIGTERM")
        machine.restoreDone?(NSError(domain: "VZErrorDomain", code: 12))
        XCTAssertEqual(machine.calls, ["restore s.vzvmsave"])
        XCTAssertEqual(rec.last["reason"] as? String, "requested")
    }

    func testSaveCommitsThenStops() {
        controller.begin(.cold)
        machine.startDone?(nil)
        var committed = false
        controller.saveAndStop(to: "/x/state.vzvmsave.tmp") { committed = true }
        XCTAssertEqual(machine.calls, ["start", "save state.vzvmsave.tmp"])
        command(#"{"v":1,"id":3,"op":"ping"}"#)
        XCTAssertEqual(rec.events.first { $0["id"] as? Int == 3 }?["state"] as? String, "saving")
        machine.saveDone?(nil)
        XCTAssertTrue(committed)
        XCTAssertEqual(rec.named("saved").count, 1)
        XCTAssertEqual(machine.calls.last, "forceStop")
        XCTAssertEqual(rec.last["reason"] as? String, "done")
        XCTAssertEqual(rec.last["ok"] as? Bool, true)
    }

    func testAFailedSaveEndsWithEState() {
        controller.begin(.cold)
        machine.startDone?(nil)
        var committed = false
        controller.saveAndStop(to: "/x/s.tmp") { committed = true }
        machine.saveDone?(NSError(domain: "VZErrorDomain", code: 3))
        XCTAssertFalse(committed)
        XCTAssertEqual(rec.last["code"] as? String, "E_STATE")
        XCTAssertEqual(machine.calls.last, "forceStop", "nothing is left running behind the helper")
    }

    func testAFailedCommitEndsWithItsError() {
        controller.begin(.cold)
        machine.startDone?(nil)
        controller.saveAndStop(to: "/x/s.tmp") { throw HelperError(.state, "rename failed") }
        machine.saveDone?(nil)
        XCTAssertEqual(rec.last["code"] as? String, "E_STATE")
        XCTAssertTrue(rec.named("saved").isEmpty)
    }

    func testCommandsAreCheckedAndAnswered() {
        controller.begin(.cold)
        machine.startDone?(nil)
        command(#"{"v":1,"id":1,"op":"ping"}"#)
        command(#"{"v":2,"id":2,"op":"ping"}"#)
        command(#"{"v":1,"id":3,"op":"boot"}"#)
        command(#"{"v":1,"id":4,"op":"stop","graceMs":600000}"#)
        command(#"{"v":1,"op":"ping"}"#)
        command("not json")
        controller.handle(.oversize)
        let answers = rec.events.filter { $0["id"] != nil }
        XCTAssertEqual(answers.map { $0["id"] as? Int }, [1, 2, 3, 4])
        XCTAssertEqual(answers[0]["state"] as? String, "running")
        XCTAssertEqual(answers[1]["code"] as? String, protocolErrorCode)
        XCTAssertEqual(answers[2]["message"] as? String, "unknown command")
        XCTAssertEqual(answers[3]["ok"] as? Bool, false)
        XCTAssertNil(rec.exitCode)
        XCTAssertEqual(rec.logs.filter { $0.hasPrefix("warn") }.count, 6)
    }
}

/// The NDJSON framing.
final class FramingTests: XCTestCase {
    func testLinesSplitAcrossFeedsAndOversizeLinesAreDropped() {
        var r = LineReader()
        XCTAssertEqual(r.feed(Data("{\"a\":1}\n{\"b\"".utf8)), [.line(Data("{\"a\":1}".utf8))])
        XCTAssertEqual(r.feed(Data(":2}\n".utf8)), [.line(Data("{\"b\":2}".utf8))])
        XCTAssertEqual(r.feed(Data(repeating: 0x61, count: 65537) + Data("\nnext\n".utf8)), [.oversize, .line(Data("next".utf8))])
    }

    func testEncodeStampsTheVersionAndDecodeWantsIt() throws {
        let line = try XCTUnwrap(encodeLine(["event": "x", "path": "/a/b"]))
        XCTAssertEqual(String(decoding: line, as: UTF8.self), "{\"event\":\"x\",\"path\":\"/a/b\",\"v\":1}\n")
        XCTAssertEqual(decodeLine(line.dropLast())?["event"] as? String, "x")
        XCTAssertNil(decodeLine(Data("{\"event\":\"x\"}".utf8)))
        XCTAssertNil(decodeLine(Data("{\"v\":true}".utf8)))
        XCTAssertNil(encodeLine(["big": String(repeating: "a", count: maxLineBytes)]), "a line over the cap is never sent")
    }

    func testMessagesAreBounded() {
        XCTAssertEqual(bounded("short"), "short")
        let long = bounded(String(repeating: "é", count: 3000))
        XCTAssertLessThanOrEqual(long.utf8.count, maxMessageBytes)
        XCTAssertTrue(long.hasSuffix("..."))
    }
}
