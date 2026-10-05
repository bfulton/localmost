import XCTest
@testable import MacVMAgentCore
@testable import MacVMCore

/// The guest, faked: what the agent asked of it.
final class FakeSystem: AgentSystem {
    var versions = ["2.330.0"]
    var done = true
    var calls: [String] = []
    var output: ((String, String) -> Void)?
    var exit: ((Int32?, String?) -> Void)?
    var signals: [JobSignal] = []
    var installed: Data?

    func installedRunnerVersions() -> [String] { versions }
    func osVersion() -> String { "26.6.2" }
    func setupDone() -> Bool { done }
    func setTime(ms: Int64) throws { calls.append("time \(ms)") }
    func addEntropy(_ bytes: Data) throws { calls.append("entropy \(bytes.count)") }
    func startRelays(proxyPort: Int, brokerPort: Int) throws { calls.append("relays \(proxyPort) \(brokerPort)") }
    func installRunner(_ upload: RunnerUpload, bytes: Data) throws {
        calls.append("install \(upload.version) \(bytes.count)")
        installed = bytes
        versions.append(upload.version)
    }
    func startJob(_ spec: JobSpec, output: @escaping (String, String) -> Void, exit: @escaping (Int32?, String?) -> Void) throws -> Int32 {
        calls.append("job \(spec.runnerVersion) \(spec.args)")
        self.output = output
        self.exit = exit
        return 4242
    }
    func signalJob(_ signal: JobSignal) { signals.append(signal) }
}

final class SessionTests: XCTestCase {
    private var system: FakeSystem!
    private var boot: BootState!
    private var sent: [[String: Any]] = []

    override func setUp() {
        system = FakeSystem()
        boot = BootState()
        sent = []
    }

    private func session() -> AgentSession {
        AgentSession(system: system, boot: boot, send: { [unowned self] line in
            XCTAssertEqual(line.last, UInt8(ascii: "\n"))
            self.sent.append(decodeLine(line.dropLast()) ?? [:])
        })
    }

    private func send(_ s: AgentSession, _ json: String) {
        s.received(Data((json + "\n").utf8))
        s.drain()
    }

    private func answer(_ id: Int) -> [String: Any]? { sent.first { $0["id"] as? Int == id } }

    private let prepare = #"{"v":1,"id":1,"op":"prepare","timeMs":1790000000000,"entropy":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","proxyPort":41000,"brokerPort":8787}"#
    private let job = #"{"v":1,"id":2,"op":"job","runnerVersion":"2.330.0","files":{".runner":"{}",".credentials":"{}",".credentials_rsaparams":"{}"},"env":{"HTTPS_PROXY":"http://x:y@127.0.0.1:41000"},"args":["--once"]}"#

    func testHelloSaysReadyOnlyBeforeAnyJobAndAfterSetup() {
        let s = session()
        s.greet()
        s.drain()
        XCTAssertEqual(sent.last?["event"] as? String, "hello")
        XCTAssertEqual(sent.last?["ready"] as? Bool, true)
        XCTAssertEqual(sent.last?["runnerVersions"] as? [String], ["2.330.0"])
        system.done = false
        s.greet()
        s.drain()
        XCTAssertEqual(sent.last?["ready"] as? Bool, false)
    }

    func testAJobRunsAfterPrepareAndItsOutputAndExitFlow() {
        let s = session()
        send(s, prepare)
        XCTAssertEqual(answer(1)?["ok"] as? Bool, true)
        XCTAssertEqual(system.calls, ["time 1790000000000", "entropy 32", "relays 41000 8787"])
        send(s, job)
        XCTAssertEqual(answer(2)?["pid"] as? Int, 4242)
        system.output?("stdout", "√ Connected to GitHub")
        system.exit?(0, nil)
        s.drain()
        XCTAssertEqual(sent.first { $0["event"] as? String == "output" }?["data"] as? String, "√ Connected to GitHub")
        let exit = sent.first { $0["event"] as? String == "exit" }
        XCTAssertEqual(exit?["code"] as? Int, 0)
        XCTAssertTrue(exit?["signal"] is NSNull)
    }

    func testOneJobPerBootEvenOnAnotherConnection() {
        let s = session()
        send(s, prepare)
        send(s, job)
        let other = session()
        send(other, job.replacingOccurrences(of: "\"id\":2", with: "\"id\":3"))
        XCTAssertEqual(answer(3)?["ok"] as? Bool, false)
        XCTAssertEqual(answer(3)?["message"] as? String, "a job already ran in this VM")
        send(other, prepare.replacingOccurrences(of: "\"id\":1", with: "\"id\":4"))
        XCTAssertEqual(answer(4)?["ok"] as? Bool, false)
        other.greet()
        other.drain()
        XCTAssertEqual(sent.last?["ready"] as? Bool, false, "a VM that ran a job is never ready again")
    }

    func testAJobNeedsPrepareFirstAndPrepareComesOnce() {
        let s = session()
        send(s, job)
        XCTAssertEqual(answer(2)?["message"] as? String, "prepare must come before a job")
        send(s, prepare)
        send(s, prepare.replacingOccurrences(of: "\"id\":1", with: "\"id\":5"))
        XCTAssertEqual(answer(5)?["message"] as? String, "this VM was already prepared")
    }

    func testSignalsGoOnlyToTheJobThisConnectionStarted() {
        let s = session()
        send(s, prepare)
        let other = session()
        send(other, #"{"v":1,"id":9,"op":"signal","signal":"KILL"}"#)
        XCTAssertEqual(answer(9)?["ok"] as? Bool, false)
        send(s, job)
        send(s, #"{"v":1,"id":10,"op":"signal","signal":"TERM"}"#)
        send(s, #"{"v":1,"id":11,"op":"signal","signal":"HUP"}"#)
        XCTAssertEqual(system.signals, [.TERM])
        XCTAssertEqual(answer(11)?["ok"] as? Bool, false)
    }

    func testClosingTheConnectionKillsItsRunningJob() {
        let s = session()
        send(s, prepare)
        send(s, job)
        s.connectionClosed()
        s.drain()
        XCTAssertEqual(system.signals, [.KILL])
    }

    func testClosingAfterTheJobEndedKillsNothing() {
        let s = session()
        send(s, prepare)
        send(s, job)
        system.exit?(1, nil)
        s.drain()
        s.connectionClosed()
        s.drain()
        XCTAssertEqual(system.signals, [])
    }

    func testARunnerUploadReadsExactlyItsBytesThenLinesAgain() {
        system.versions = []
        let s = session()
        let payload = Data("0123456789".utf8)
        let header = #"{"v":1,"id":7,"op":"runner","version":"2.331.0","bytes":10,"sha256":"\#(String(repeating: "a", count: 64))"}"# + "\n"
        // The header, the bytes and the next command arrive together.
        s.received(Data(header.utf8) + payload + Data((#"{"v":1,"id":8,"op":"ping"}"# + "\n").utf8))
        s.drain()
        XCTAssertEqual(answer(7)?["send"] as? Bool, true)
        XCTAssertEqual(system.installed, payload)
        XCTAssertEqual(sent.filter { $0["id"] as? Int == 7 }.last?["installed"] as? String, "2.331.0")
        XCTAssertEqual(answer(8)?["ok"] as? Bool, true)
    }

    func testAnInstalledRunnerIsNotUploadedAgain() {
        let s = session()
        send(s, #"{"v":1,"id":7,"op":"runner","version":"2.330.0","bytes":10,"sha256":"\#(String(repeating: "a", count: 64))"}"#)
        XCTAssertEqual(answer(7)?["ok"] as? Bool, false)
    }

    func testBadCommandsAreRefusedNotFatal() {
        let s = session()
        s.received(Data("nonsense\n".utf8))
        send(s, #"{"v":1,"op":"ping"}"#)
        send(s, #"{"v":1,"id":1,"op":"shell","cmd":"id"}"#)
        XCTAssertEqual(sent.filter { $0["event"] as? String == "error" }.count, 2)
        XCTAssertEqual(answer(1)?["message"] as? String, "unknown command")
    }
}

final class StreamReaderTests: XCTestCase {
    func testLinesThenRawThenLines() {
        var r = StreamReader()
        r.append(Data("a\nbcdef\n".utf8))
        XCTAssertEqual(r.next(), .line(Data("a".utf8)))
        r.expectRaw(3)
        XCTAssertEqual(r.next(), .raw(Data("bcd".utf8)))
        XCTAssertEqual(r.next(), .line(Data("ef".utf8)))
        XCTAssertNil(r.next())
    }

    func testRawWaitsForAllItsBytes() {
        var r = StreamReader()
        r.expectRaw(4)
        r.append(Data("ab".utf8))
        XCTAssertNil(r.next())
        r.append(Data("cd\n".utf8))
        XCTAssertEqual(r.next(), .raw(Data("abcd".utf8)))
        XCTAssertEqual(r.next(), .line(Data()))
    }

    func testOversizeLinesAreDroppedOnce() {
        var r = StreamReader()
        r.append(Data(repeating: 0x61, count: maxLineBytes + 10))
        XCTAssertEqual(r.next(), .oversize)
        r.append(Data(repeating: 0x61, count: 100))
        XCTAssertNil(r.next())
        r.append(Data("tail\nok\n".utf8))
        XCTAssertEqual(r.next(), .line(Data("ok".utf8)))
    }
}
