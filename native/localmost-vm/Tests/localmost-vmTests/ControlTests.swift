import XCTest
@testable import localmost_vm

/// NDJSON framing (contract §2.4): one object per line, 64 KiB at most.
final class LineReaderTests: XCTestCase {
    func testLinesSplitOnNewlineAcrossFeeds() {
        var r = LineReader()
        XCTAssertEqual(r.feed(Data("{\"a\":1}\n{\"b\"".utf8)), [.line(Data("{\"a\":1}".utf8))])
        XCTAssertEqual(r.feed(Data(":2}\n\n".utf8)), [.line(Data("{\"b\":2}".utf8)), .line(Data())])
    }

    func testALineOfExactly64KiBIsKept() {
        var r = LineReader()
        let line = Data(repeating: 0x61, count: 65536)
        XCTAssertEqual(r.feed(line + Data("\n".utf8)), [.line(line)])
    }

    func testALineOverTheCapIsDroppedOnceAndTheNextLineIsRead() {
        var r = LineReader()
        var items = r.feed(Data(repeating: 0x61, count: 40000))
        items += r.feed(Data(repeating: 0x61, count: 40000))
        XCTAssertEqual(items, [.oversize], "reported once, as soon as it passes the cap")
        items = r.feed(Data(repeating: 0x61, count: 100000))
        XCTAssertEqual(items, [], "the rest of it is discarded without buffering")
        XCTAssertEqual(r.feed(Data("x\n{\"ok\":1}\n".utf8)), [.line(Data("{\"ok\":1}".utf8))])
    }

    func testALineOverTheCapInOneFeedIsDropped() {
        var r = LineReader()
        let items = r.feed(Data(repeating: 0x61, count: 65537) + Data("\nnext\n".utf8))
        XCTAssertEqual(items, [.oversize, .line(Data("next".utf8))])
    }

    func testTheBufferNeverHoldsMuchMoreThanTheCap() {
        var r = LineReader()
        for _ in 0..<64 {
            _ = r.feed(Data(repeating: 0x61, count: 64 << 10))
            XCTAssertLessThanOrEqual(r.buffered, 65536)
        }
    }
}

/// The commands, their answers, and the events, against a fake VM.
final class ControllerTests: XCTestCase {
    private var machine: FakeMachine!
    private var out: [[String: Any]] = []
    private var logs: [String] = []
    private var exitCode: Int32?
    private var syncs = 0
    private var syncError: HelperError?
    private var timers: [(Int, () -> Void)] = []
    /// The machine holds its controller weakly, as the process does not; the test keeps it.
    private var current: Controller?

    override func setUp() {
        machine = FakeMachine()
        out = []
        logs = []
        exitCode = nil
        syncs = 0
        syncError = nil
        timers = []
    }

    private func controller(_ mode: Mode = .job(sandboxId: "3-a1b2c3d4e5f6", proxyPort: 3128), rosetta: String = "installed") -> Controller {
        let c = Controller(
            mode: mode,
            rosetta: rosetta,
            machine: machine,
            hooks: ControllerHooks(
                emit: { [unowned self] line in
                    XCTAssertFalse(line.dropLast().contains(UInt8(ascii: "\n")), "one object per line")
                    XCTAssertEqual(line.last, UInt8(ascii: "\n"))
                    XCTAssertLessThanOrEqual(line.count, 65536)
                    let obj = try! JSONSerialization.jsonObject(with: line) as! [String: Any]
                    XCTAssertEqual(obj["v"] as? Int, 1, "every object carries v:1")
                    self.out.append(obj)
                },
                log: { [unowned self] level, message in self.logs.append("\(level) \(message)") },
                startMs: { 42 },
                syncDisk: { [unowned self] in
                    self.syncs += 1
                    if let e = self.syncError { throw e }
                },
                after: { [unowned self] ms, block in self.timers.append((ms, block)) },
                finish: { [unowned self] code in
                    XCTAssertNil(self.exitCode, "finished twice")
                    self.exitCode = code
                }
            )
        )
        current = c
        return c
    }

    private func booted(_ mode: Mode = .job(sandboxId: "3-a1b2c3d4e5f6", proxyPort: 3128)) -> Controller {
        let c = controller(mode)
        c.begin(dockerSocket: "/d/docker.sock", agentSocket: "/d/agent.sock", preStart: {})
        machine.completeStart(nil)
        return c
    }

    private func send(_ c: Controller, _ json: String) {
        c.handle(.line(Data(json.utf8)))
    }

    private var events: [String] { out.compactMap { $0["event"] as? String } }
    private func answer(_ id: Int) -> [String: Any]? { out.first { $0["id"] as? Int == id } }

    // MARK: - Events

    func testTheEventsComeInOrderListeningStartedStopped() {
        let c = controller()
        c.begin(dockerSocket: "/d/docker.sock", agentSocket: "/d/agent.sock", preStart: {})
        XCTAssertEqual(events, ["listening"])
        XCTAssertEqual(out[0]["dockerSocket"] as? String, "/d/docker.sock")
        XCTAssertEqual(out[0]["agentSocket"] as? String, "/d/agent.sock")
        XCTAssertEqual(machine.starts, 1, "start follows listening")
        machine.completeStart(nil)
        XCTAssertEqual(events, ["listening", "started"])
        machine.guestStops()
        XCTAssertEqual(events, ["listening", "started", "stopped"])
        XCTAssertEqual(out[2]["reason"] as? String, "guest")
        XCTAssertEqual(exitCode, 0)
    }

    func testStartedCarriesTheHelpersOwnPidRosettaAndStartTime() {
        let c = controller(rosetta: "notInstalled")
        c.begin(dockerSocket: "/d/docker.sock", agentSocket: "/d/agent.sock", preStart: {})
        machine.completeStart(nil)
        let started = out[1]
        XCTAssertEqual(started["pid"] as? Int, Int(getpid()))
        XCTAssertEqual(started["rosetta"] as? String, "notInstalled")
        XCTAssertEqual(started["startMs"] as? Int, 42)
    }

    func testAFailedPreStartCheckNeverStartsTheVm() {
        let c = controller()
        c.begin(dockerSocket: "/d/docker.sock", agentSocket: "/d/agent.sock", preStart: { throw HelperError(.share, "a link") })
        XCTAssertEqual(machine.starts, 0)
        XCTAssertEqual(events, ["listening", "stopped"])
        XCTAssertEqual(out[1]["reason"] as? String, "error")
        XCTAssertEqual(out[1]["code"] as? String, "E_SHARE")
        XCTAssertEqual(out[1]["message"] as? String, "a link")
        XCTAssertEqual(exitCode, 65)
    }

    func testAFailedStartIsVzStart() {
        let c = controller()
        c.begin(dockerSocket: "/d/docker.sock", agentSocket: "/d/agent.sock", preStart: {})
        machine.completeStart(NSError(domain: NSPOSIXErrorDomain, code: Int(EPERM)))
        XCTAssertEqual(events, ["listening", "stopped"])
        XCTAssertEqual(out[1]["code"] as? String, "E_VZ_START")
        XCTAssertEqual(exitCode, 69)
    }

    func testAGuestErrorIsGuestError() {
        _ = booted()
        machine.onStop?(.error("the guest crashed"))
        XCTAssertEqual(out.last?["reason"] as? String, "error")
        XCTAssertEqual(out.last?["code"] as? String, "E_GUEST_ERROR")
        XCTAssertEqual(exitCode, 71)
    }

    func testAnErrorBeforeListeningIsReportedAsStopped() {
        let c = controller()
        c.fail(HelperError(.guestImage, "rootfs.erofs is 1 byte"))
        XCTAssertEqual(events, ["stopped"])
        XCTAssertEqual(out[0]["code"] as? String, "E_GUEST_IMAGE")
        XCTAssertEqual(exitCode, 66)
        XCTAssertTrue(logs.contains("error rootfs.erofs is 1 byte"), "\(logs)")
    }

    // MARK: - stop

    func testStopWithoutGraceForcesTheVmOffAndAnswersFirst() {
        let c = booted()
        send(c, #"{"v":1,"id":7,"op":"stop","graceMs":0}"#)
        XCTAssertEqual(machine.requests, 0, "no grace, no request")
        XCTAssertEqual(machine.forces, 1)
        XCTAssertEqual(answer(7)?["ok"] as? Bool, true)
        machine.completeForce(nil)
        XCTAssertEqual(events, ["listening", "started", "stopped"])
        XCTAssertEqual(out.last?["reason"] as? String, "requested")
        let answerIndex = out.firstIndex { $0["id"] as? Int == 7 }!
        XCTAssertLessThan(answerIndex, out.count - 1, "the answer comes before stopped")
        XCTAssertEqual(exitCode, 0)
    }

    func testStopWithGraceAsksTheGuestAndStopsCleanlyWhenItPowersOff() {
        let c = booted()
        send(c, #"{"v":1,"id":1,"op":"stop","graceMs":5000}"#)
        XCTAssertEqual(machine.requests, 1)
        XCTAssertEqual(machine.forces, 0)
        XCTAssertEqual(timers.map(\.0), [5000])
        send(c, #"{"v":1,"id":2,"op":"ping"}"#)
        XCTAssertEqual(answer(2)?["state"] as? String, "stopping")
        machine.guestStops()
        XCTAssertEqual(out.last?["reason"] as? String, "requested", "the guest stopped because it was asked")
        timers[0].1()
        XCTAssertEqual(machine.forces, 0, "the grace timer does nothing once the VM stopped")
        XCTAssertEqual(exitCode, 0)
    }

    func testStopWithGraceForcesTheVmWhenTheGraceRunsOut() {
        let c = booted()
        send(c, #"{"v":1,"id":1,"op":"stop","graceMs":100}"#)
        timers[0].1()
        XCTAssertEqual(machine.forces, 1)
        machine.completeForce(nil)
        XCTAssertEqual(out.last?["reason"] as? String, "requested")
    }

    func testAStopWithoutGraceDuringAGracefulStopForcesAtOnce() {
        let c = booted()
        send(c, #"{"v":1,"id":1,"op":"stop","graceMs":60000}"#)
        send(c, #"{"v":1,"id":2,"op":"stop","graceMs":0}"#)
        XCTAssertEqual(machine.forces, 1)
        XCTAssertEqual(answer(2)?["ok"] as? Bool, true)
        timers[0].1()
        XCTAssertEqual(machine.forces, 1, "forced once")
    }

    func testAStopWhileStartingStopsOnceTheVmHasStarted() {
        let c = controller()
        c.begin(dockerSocket: "/d/docker.sock", agentSocket: "/d/agent.sock", preStart: {})
        send(c, #"{"v":1,"id":1,"op":"ping"}"#)
        XCTAssertEqual(answer(1)?["state"] as? String, "starting")
        send(c, #"{"v":1,"id":2,"op":"stop","graceMs":3000}"#)
        XCTAssertEqual(answer(2)?["ok"] as? Bool, true)
        XCTAssertEqual(machine.forces, 0)
        machine.completeStart(nil)
        XCTAssertEqual(machine.forces, 1, "a guest that has just started cannot be asked; it is forced")
        machine.completeForce(nil)
        XCTAssertEqual(events, ["listening", "started", "stopped"])
    }

    func testAGuestThatCannotBeAskedIsForced() {
        let c = booted()
        machine.canRequest = false
        send(c, #"{"v":1,"id":1,"op":"stop","graceMs":3000}"#)
        XCTAssertEqual(machine.forces, 1)
    }

    func testAFailedForcedStopIsAnError() {
        let c = booted()
        send(c, #"{"v":1,"id":1,"op":"stop","graceMs":0}"#)
        machine.completeForce(NSError(domain: "VZ", code: 1))
        XCTAssertEqual(out.last?["reason"] as? String, "error")
        XCTAssertEqual(exitCode, 71)
    }

    func testStopAfterStoppedIsAnsweredAndChangesNothing() {
        let c = booted()
        machine.guestStops()
        send(c, #"{"v":1,"id":9,"op":"stop","graceMs":0}"#)
        XCTAssertEqual(answer(9)?["ok"] as? Bool, true)
        XCTAssertEqual(events.filter { $0 == "stopped" }.count, 1)
    }

    func testTheOtherStopPathsAreStopWithoutGrace() {
        for (name, trigger) in [("parent", { (c: Controller) in c.parentGone() }),
                                ("stdin EOF", { (c: Controller) in c.inputClosed() }),
                                ("signal", { (c: Controller) in c.signalled("SIGTERM") })] {
            setUp()
            let c = booted()
            trigger(c)
            XCTAssertEqual(machine.forces, 1, name)
            XCTAssertEqual(machine.requests, 0, name)
            machine.completeForce(nil)
            XCTAssertEqual(out.last?["reason"] as? String, "requested", name)
            XCTAssertEqual(exitCode, 0, name)
        }
    }

    func testTheParentGoingBeforeStartExitsWithoutStarting() {
        let c = controller()
        c.parentGone()
        XCTAssertEqual(events, ["stopped"])
        XCTAssertEqual(out[0]["reason"] as? String, "requested")
        XCTAssertEqual(exitCode, 0)
        c.begin(dockerSocket: "/d/docker.sock", agentSocket: "/d/agent.sock", preStart: {})
        XCTAssertEqual(machine.starts, 0, "nothing starts after the stop")
    }

    // MARK: - ping and bad commands

    func testPingAnswersTheState() {
        let c = booted()
        send(c, #"{"v":1,"id":3,"op":"ping"}"#)
        XCTAssertEqual(answer(3)?["ok"] as? Bool, true)
        XCTAssertEqual(answer(3)?["state"] as? String, "running")
    }

    func testAnUnknownCommandIsRefusedWithItsId() {
        let c = booted()
        send(c, #"{"v":1,"id":4,"op":"start"}"#)
        XCTAssertEqual(answer(4)?["ok"] as? Bool, false)
        XCTAssertEqual(answer(4)?["code"] as? String, "E_PROTO")
        XCTAssertNotNil(answer(4)?["message"] as? String)
        XCTAssertEqual(machine.forces, 0)
        XCTAssertNil(exitCode, "a bad command is refused, not fatal")
    }

    func testMalformedStopsAreRefused() {
        let c = booted()
        for (id, body) in [(10, #""graceMs":-1"#), (11, #""graceMs":60001"#), (12, #""graceMs":"5""#), (13, #""graceMs":1.5"#),
                           (14, #""graceMs":true"#), (15, "\"x\":0")] {
            send(c, "{\"v\":1,\"id\":\(id),\"op\":\"stop\",\(body)}")
            XCTAssertEqual(answer(id)?["code"] as? String, "E_PROTO", body)
        }
        XCTAssertEqual(machine.forces + machine.requests, 0)
    }

    func testAWrongVersionIsRefused() {
        let c = booted()
        send(c, #"{"v":2,"id":5,"op":"ping"}"#)
        XCTAssertEqual(answer(5)?["code"] as? String, "E_PROTO")
    }

    func testALineWithoutAUsableIdIsLoggedAndNotAnswered() {
        let c = booted()
        let before = out.count
        for bad in ["not json", "[]", #"{"v":1,"op":"ping"}"#, #"{"v":1,"id":"1","op":"ping"}"#, #"{"v":1,"id":1.5,"op":"ping"}"#,
                    #"{"v":1,"id":true,"op":"ping"}"#] {
            send(c, bad)
        }
        c.handle(.oversize)
        XCTAssertEqual(out.count, before, "nothing to answer without an id")
        XCTAssertEqual(logs.filter { $0.hasPrefix("warn ") }.count, 7, "\(logs)")
        XCTAssertNil(exitCode)
    }

    // MARK: - Refresh mode

    func testARefreshSyncsTheDiskAfterTheGuestPowersOff() {
        _ = booted(.refresh(repoKey: "0123456789abcdef"))
        machine.guestStops()
        XCTAssertEqual(syncs, 1)
        XCTAssertEqual(out.last?["reason"] as? String, "guest")
        XCTAssertEqual(out.last?["synced"] as? Bool, true)
        XCTAssertEqual(exitCode, 0)
    }

    func testAFailedSyncIsESync() {
        syncError = HelperError(.sync, "F_FULLFSYNC: Input/output error")
        _ = booted(.refresh(repoKey: "0123456789abcdef"))
        machine.guestStops()
        XCTAssertEqual(out.last?["reason"] as? String, "error")
        XCTAssertEqual(out.last?["code"] as? String, "E_SYNC")
        XCTAssertEqual(out.last?["synced"] as? Bool, false)
        XCTAssertEqual(exitCode, 72)
    }

    func testARequestedStopOfARefreshIsNeverSynced() {
        let c = booted(.refresh(repoKey: "0123456789abcdef"))
        send(c, #"{"v":1,"id":1,"op":"stop","graceMs":0}"#)
        machine.completeForce(nil)
        XCTAssertEqual(syncs, 0)
        XCTAssertEqual(out.last?["synced"] as? Bool, false)
    }

    func testAJobIsNeverSynced() {
        _ = booted()
        machine.guestStops()
        XCTAssertEqual(syncs, 0)
        XCTAssertEqual(out.last?["synced"] as? Bool, false)
    }

    // MARK: - Encoding

    func testLongMessagesAreBoundedToOneLine() {
        let c = controller()
        c.fail(HelperError(.vzConfig, String(repeating: "x\n", count: 100_000)))
        let message = out[0]["message"] as! String
        XCTAssertLessThanOrEqual(message.utf8.count, 4096)
        XCTAssertEqual(exitCode, 68)
    }
}

/// A VM that does what the test says, when it says.
final class FakeMachine: Machine {
    var onStop: ((MachineStopCause) -> Void)?
    var canRequest = true
    private(set) var starts = 0
    private(set) var requests = 0
    private(set) var forces = 0
    private var startDone: ((Error?) -> Void)?
    private var forceDone: ((Error?) -> Void)?

    func start(_ done: @escaping (Error?) -> Void) {
        starts += 1
        startDone = done
    }

    func requestStop() -> Bool {
        requests += 1
        return canRequest
    }

    func forceStop(_ done: @escaping (Error?) -> Void) {
        forces += 1
        forceDone = done
    }

    func completeStart(_ error: Error?) {
        startDone?(error)
        startDone = nil
    }

    func completeForce(_ error: Error?) {
        forceDone?(error)
        forceDone = nil
    }

    func guestStops() {
        onStop?(.guest)
    }
}
