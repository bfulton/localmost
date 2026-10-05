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

    var puts: [(PutSpec, Data)] = []
    var steps: [StepSpec] = []
    var stepOutput: ((String, String) -> Void)?
    var stepExit: ((Int32?, String?, String) -> Void)?
    var stepSignals: [JobSignal] = []
    var failPut = false
    func putFiles(_ put: PutSpec, bytes: Data) throws {
        if failPut { throw ProtocolError("the upload's bytes do not match their sha256") }
        puts.append((put, bytes))
    }
    func startStep(_ spec: StepSpec, output: @escaping (String, String) -> Void,
                   exit: @escaping (Int32?, String?, String) -> Void) throws -> Int32 {
        steps.append(spec)
        stepOutput = output
        stepExit = exit
        return 5000 + Int32(steps.count)
    }
    func signalSteps(_ signal: JobSignal) { stepSignals.append(signal) }
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

    // MARK: - A localmost test run

    /// An upload's command and its bytes together, as the client sends them once told to.
    private func put(_ id: Int, _ dest: String, _ bytes: Data) -> Data {
        putHeader(id, dest, bytes.count) + bytes
    }

    /// An upload's command alone: what the client sends before the agent says to send the bytes.
    private func putHeader(_ id: Int, _ dest: String, _ count: Int = 3) -> Data {
        Data((#"{"v":1,"id":\#(id),"op":"put","dest":"\#(dest)","bytes":\#(count),"sha256":"\#(String(repeating: "a", count: 64))"}"# + "\n").utf8)
    }

    private func step(_ id: Int, _ script: String = "echo hi") -> String {
        #"{"v":1,"id":\#(id),"op":"step","program":"bash","script":"\#(script)","cwd":"workspace","env":{"GITHUB_SHA":"abc"}}"#
    }

    private func startedRun(_ s: AgentSession) {
        send(s, prepare)
        s.received(put(20, "workspace", Data("tar".utf8)))
        s.drain()
    }

    func testATestRunStartsWithItsWorkspaceAfterPrepare() {
        let s = session()
        s.received(putHeader(20, "workspace"))
        s.drain()
        XCTAssertEqual(answer(20)?["message"] as? String, "prepare must come before a test run")
        XCTAssertTrue(system.puts.isEmpty)
        send(s, prepare)
        s.received(put(21, "workspace", Data("tar".utf8)))
        s.drain()
        XCTAssertEqual(answer(21)?["send"] as? Bool, true)
        XCTAssertEqual(sent.filter { $0["id"] as? Int == 21 }.last?["put"] as? String, "workspace")
        XCTAssertEqual(system.puts.first?.0.dest, "workspace")
        XCTAssertEqual(system.puts.first?.1, Data("tar".utf8))
        send(s, #"{"v":1,"id":22,"op":"ping"}"#)
        XCTAssertEqual(answer(22)?["jobStarted"] as? Bool, true, "a VM a test run reached is spent, as after a job")
    }

    func testABootRunsAJobOrATestRunNeverBoth() {
        let s = session()
        startedRun(s)
        send(s, job.replacingOccurrences(of: "\"id\":2", with: "\"id\":23"))
        XCTAssertEqual(answer(23)?["message"] as? String, "a job already ran in this VM")

        setUp()
        let t = session()
        send(t, prepare)
        send(t, job)
        t.received(putHeader(24, "workspace"))
        t.drain()
        XCTAssertEqual(answer(24)?["message"] as? String, "a job already ran in this VM")
        XCTAssertTrue(system.puts.isEmpty)
    }

    func testTheWorkspaceComesOnceAndBeforeAnythingElseOfTheRun() {
        let s = session()
        send(s, prepare)
        s.received(putHeader(25, "actions/0123456789abcdef"))
        s.drain()
        XCTAssertEqual(answer(25)?["message"] as? String, "the workspace must come first")
        send(s, step(26))
        XCTAssertEqual(answer(26)?["message"] as? String, "the workspace must come before a step")
        s.received(put(27, "workspace", Data("tar".utf8)) + putHeader(28, "workspace"))
        s.drain()
        XCTAssertEqual(answer(28)?["message"] as? String, "the workspace was already sent")
        s.received(put(29, "actions/0123456789abcdef", Data("act".utf8)))
        s.drain()
        XCTAssertEqual(sent.filter { $0["id"] as? Int == 29 }.last?["put"] as? String, "actions/0123456789abcdef")
        XCTAssertEqual(system.puts.map { $0.0.dest }, ["workspace", "actions/0123456789abcdef"])
    }

    func testAFailedWorkspaceUploadLeavesNoRunToStepIn() {
        system.failPut = true
        let s = session()
        startedRun(s)
        XCTAssertEqual(sent.filter { $0["id"] as? Int == 20 }.last?["ok"] as? Bool, false)
        send(s, step(30))
        XCTAssertEqual(answer(30)?["message"] as? String, "the workspace must come before a step")
    }

    func testStepsRunOneAtATimeAndTheirExitCarriesTheirOutputs() throws {
        let s = session()
        startedRun(s)
        send(s, step(31))
        XCTAssertEqual(answer(31)?["pid"] as? Int, 5001)
        XCTAssertEqual(system.steps.first?.env, ["GITHUB_SHA": "abc"])
        send(s, step(32))
        XCTAssertEqual(answer(32)?["message"] as? String, "a step is already running")
        s.received(putHeader(33, "actions/0123456789abcdef"))
        s.drain()
        XCTAssertEqual(answer(33)?["message"] as? String, "a step is running")
        system.stepOutput?("stdout", "hi")
        system.stepExit?(0, nil, "result=ok\n")
        s.drain()
        XCTAssertEqual(sent.first { $0["event"] as? String == "output" }?["data"] as? String, "hi")
        let exit = try XCTUnwrap(sent.first { $0["event"] as? String == "exit" })
        XCTAssertEqual(exit["code"] as? Int, 0)
        XCTAssertEqual(exit["outputs"] as? String, "result=ok\n")
        send(s, step(34))
        XCTAssertEqual(answer(34)?["pid"] as? Int, 5002)
    }

    func testOutputsThatDoNotFitALineAreDroppedAndSaidSo() throws {
        let s = session()
        startedRun(s)
        send(s, step(35))
        system.stepExit?(1, nil, String(repeating: "\u{1}", count: maxStepOutputsBytes))
        s.drain()
        let exit = try XCTUnwrap(sent.first { $0["event"] as? String == "exit" })
        XCTAssertEqual(exit["outputs"] as? String, "")
        XCTAssertEqual(exit["code"] as? Int, 1)
        XCTAssertNotNil(sent.first { ($0["message"] as? String)?.contains("outputs were dropped") == true })
    }

    func testOnlyTheRunsConnectionSignalsItsStepsAndClosingItKillsThem() {
        let s = session()
        startedRun(s)
        let other = session()
        send(other, #"{"v":1,"id":40,"op":"signal","signal":"KILL"}"#)
        XCTAssertEqual(answer(40)?["ok"] as? Bool, false)
        other.received(putHeader(41, "actions/0123456789abcdef"))
        other.drain()
        XCTAssertEqual(answer(41)?["message"] as? String, "the workspace must come first")
        send(other, step(42))
        XCTAssertEqual(answer(42)?["ok"] as? Bool, false)
        send(s, #"{"v":1,"id":43,"op":"signal","signal":"KILL"}"#)
        XCTAssertEqual(answer(43)?["ok"] as? Bool, true)
        XCTAssertEqual(system.stepSignals, [.KILL])
        s.connectionClosed()
        s.drain()
        XCTAssertEqual(system.stepSignals, [.KILL, .KILL])
        XCTAssertEqual(system.signals, [], "a test run has no runner to signal")
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
