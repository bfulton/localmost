// One control connection to the guest agent: its commands in order, against
// an injected AgentSystem so that every rule can be tested on the host.
//
// The rules: `prepare` once per boot, before a job; a runner upload only of
// a version that is not there; one job per boot, ever - a VM is a job's,
// and is thrown away after it; signals only to that job. A connection that
// closes while its job runs kills the job: nobody is left to read it.
//
// A boot runs a runner job or a `localmost test` run, never both: the run
// starts with its workspace upload, after prepare, and its steps come one
// at a time on the connection that sent the workspace (see Steps.swift).

import Foundation
import MacVMCore

/// What the agent does to the guest, injected. Every callback may come on
/// any queue; the session serializes on its own.
public protocol AgentSystem: AnyObject {
    /// The runner versions installed under runnerRoot.
    func installedRunnerVersions() -> [String]
    /// The guest's macOS version, `26.6.2`.
    func osVersion() -> String
    /// Whether the golden image's setup finished: the job user exists, a
    /// runner is installed, and the setup's marker is there.
    func setupDone() -> Bool
    func setTime(ms: Int64) throws
    func addEntropy(_ bytes: Data) throws
    /// Starts the loopback listeners on 127.0.0.1 that relay to the host's
    /// vsock ports.
    func startRelays(proxyPort: Int, brokerPort: Int) throws
    /// Installs a runner from a tar.gz whose bytes `next` hands over, after
    /// checking its sha256.
    func installRunner(_ upload: RunnerUpload, bytes: Data) throws
    /// Starts the job's runner as the job user. `output` gets its lines,
    /// `exit` its end, once.
    func startJob(_ spec: JobSpec, output: @escaping (String, String) -> Void, exit: @escaping (Int32?, String?) -> Void) throws -> Int32
    func signalJob(_ signal: JobSignal)
    /// Unpacks a test run's upload, a tar whose bytes are handed over, into
    /// testRoot/<dest> as the job user, after checking its sha256.
    func putFiles(_ put: PutSpec, bytes: Data) throws
    /// Starts one step as the job user. `output` gets its lines, `exit` its
    /// end and what it wrote to GITHUB_OUTPUT, once.
    func startStep(_ spec: StepSpec, output: @escaping (String, String) -> Void,
                   exit: @escaping (Int32?, String?, String) -> Void) throws -> Int32
    /// Signals every process group a step of this boot started.
    func signalSteps(_ signal: JobSignal)
}

/// Whether a job has started in this boot. Shared by every connection: the
/// agent process is the boot.
public final class BootState {
    private let lock = NSLock()
    private var _prepared = false
    private var _jobStarted = false
    private var _testStarted = false

    public init() {}

    public var prepared: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _prepared
    }

    /// Whether a job or a test run has reached this boot.
    public var jobStarted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _jobStarted || _testStarted
    }

    func markPrepared() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !_prepared else { return false }
        _prepared = true
        return true
    }

    func markJobStarted() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !_jobStarted, !_testStarted else { return false }
        _jobStarted = true
        return true
    }

    func markTestStarted() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !_jobStarted, !_testStarted else { return false }
        _testStarted = true
        return true
    }
}

public final class AgentSession {
    private let system: AgentSystem
    private let boot: BootState
    private let send: (Data) -> Void
    private let queue = DispatchQueue(label: "localmost-macvm-agent session")
    private var reader = StreamReader()
    private enum Upload {
        case runner(RunnerUpload)
        case put(PutSpec)
    }

    /// The upload whose bytes are arriving, and its command id.
    private var upload: (id: Int, what: Upload)?
    private var ownsJob = false
    private var jobRunning = false
    /// This connection sent the test run's workspace; it has arrived; a step runs.
    private var ownsTest = false
    private var workspaceReady = false
    private var stepRunning = false
    private var closed = false

    public init(system: AgentSystem, boot: BootState, send: @escaping (Data) -> Void) {
        self.system = system
        self.boot = boot
        self.send = send
    }

    /// The hello every connection starts with.
    public func greet() {
        queue.async {
            let ready = self.system.setupDone() && !self.boot.jobStarted && !self.boot.prepared
            self.emit(["event": "hello", "agent": agentVersion, "ready": ready, "os": self.system.osVersion(),
                       "runnerVersions": self.system.installedRunnerVersions().sorted()])
        }
    }

    /// Bytes from the connection.
    public func received(_ data: Data) {
        queue.async { self.feed(data) }
    }

    /// The connection closed. A job it started is killed.
    public func connectionClosed() {
        queue.async {
            self.closed = true
            if self.ownsJob, self.jobRunning {
                self.system.signalJob(.KILL)
            }
            if self.ownsTest {
                self.system.signalSteps(.KILL)
            }
        }
    }

    /// For tests: waits until everything queued so far has run.
    public func drain() {
        queue.sync {}
    }

    private func feed(_ data: Data) {
        reader.append(data)
        while let item = reader.next() {
            switch item {
            case .line(let line):
                handle(line)
            case .oversize:
                emit(["event": "error", "message": "a command over \(maxLineBytes) bytes was dropped"])
            case .raw(let bytes):
                finishUpload(bytes)
            }
        }
    }

    private func handle(_ line: Data) {
        guard let object = decodeLine(line) else {
            return emit(["event": "error", "message": "a command that is not a v1 JSON object was dropped"])
        }
        guard let idNumber = object["id"] as? NSNumber, isInteger(idNumber) else {
            return emit(["event": "error", "message": "a command without an integer id was dropped"])
        }
        let id = idNumber.intValue
        do {
            switch object["op"] as? String {
            case "ping":
                reply(id, ["jobStarted": boot.jobStarted])
            case "prepare":
                let p = try parsePrepare(object)
                guard !boot.jobStarted else { throw ProtocolError("a job already ran in this VM") }
                guard boot.markPrepared() else { throw ProtocolError("this VM was already prepared") }
                try system.setTime(ms: p.timeMs)
                try system.addEntropy(p.entropy)
                try system.startRelays(proxyPort: p.proxyPort, brokerPort: p.brokerPort)
                reply(id)
            case "runner":
                let u = try parseRunnerUpload(object)
                guard !boot.jobStarted else { throw ProtocolError("a job already ran in this VM") }
                guard !system.installedRunnerVersions().contains(u.version) else {
                    throw ProtocolError("runner \(u.version) is already installed")
                }
                upload = (id, .runner(u))
                reader.expectRaw(u.bytes)
                reply(id, ["send": true])
            case "job":
                let spec = try parseJob(object)
                guard boot.prepared else { throw ProtocolError("prepare must come before a job") }
                guard system.installedRunnerVersions().contains(spec.runnerVersion) else {
                    throw ProtocolError("runner \(spec.runnerVersion) is not installed")
                }
                guard boot.markJobStarted() else { throw ProtocolError("a job already ran in this VM") }
                ownsJob = true
                jobRunning = true
                let pid = try system.startJob(spec, output: { [weak self] stream, data in
                    self?.queue.async { self?.emit(["event": "output", "stream": stream, "data": data]) }
                }, exit: { [weak self] code, signal in
                    self?.queue.async {
                        guard let self = self else { return }
                        self.jobRunning = false
                        var fields: [String: Any] = ["event": "exit"]
                        fields["code"] = code.map { Int($0) } ?? NSNull()
                        fields["signal"] = signal ?? NSNull()
                        self.emit(fields)
                    }
                })
                reply(id, ["pid": Int(pid)])
            case "put":
                let p = try parsePut(object)
                guard boot.prepared else { throw ProtocolError("prepare must come before a test run") }
                guard !stepRunning else { throw ProtocolError("a step is running") }
                if p.dest == "workspace" {
                    guard !ownsTest else { throw ProtocolError("the workspace was already sent") }
                    guard boot.markTestStarted() else { throw ProtocolError("a job already ran in this VM") }
                    ownsTest = true
                } else {
                    guard ownsTest, workspaceReady else { throw ProtocolError("the workspace must come first") }
                }
                upload = (id, .put(p))
                reader.expectRaw(p.bytes)
                reply(id, ["send": true])
            case "step":
                let spec = try parseStep(object)
                guard ownsTest, workspaceReady else { throw ProtocolError("the workspace must come before a step") }
                guard !stepRunning else { throw ProtocolError("a step is already running") }
                stepRunning = true
                do {
                    let pid = try system.startStep(spec, output: { [weak self] stream, data in
                        self?.queue.async { self?.emit(["event": "output", "stream": stream, "data": data]) }
                    }, exit: { [weak self] code, signal, outputs in
                        self?.queue.async { self?.stepEnded(code: code, signal: signal, outputs: outputs) }
                    })
                    reply(id, ["pid": Int(pid)])
                } catch {
                    stepRunning = false
                    throw error
                }
            case "signal":
                let signal = try parseSignal(object)
                if ownsTest {
                    system.signalSteps(signal)
                    return reply(id)
                }
                guard ownsJob else { throw ProtocolError("this connection started no job") }
                system.signalJob(signal)
                reply(id)
            default:
                throw ProtocolError("unknown command")
            }
        } catch let e as ProtocolError {
            refuse(id, e.message)
        } catch {
            refuse(id, describe(error))
        }
    }

    private func finishUpload(_ bytes: Data) {
        guard let (id, what) = upload else { return }
        upload = nil
        do {
            switch what {
            case .runner(let spec):
                try system.installRunner(spec, bytes: bytes)
                reply(id, ["installed": spec.version])
            case .put(let spec):
                try system.putFiles(spec, bytes: bytes)
                if spec.dest == "workspace" { workspaceReady = true }
                reply(id, ["put": spec.dest])
            }
        } catch let e as ProtocolError {
            refuse(id, e.message)
        } catch {
            refuse(id, describe(error))
        }
    }

    /// A step's exit, with its outputs if they fit one line; otherwise
    /// without them, and an error that says so.
    private func stepEnded(code: Int32?, signal: String?, outputs: String) {
        stepRunning = false
        var fields: [String: Any] = ["event": "exit", "outputs": outputs]
        fields["code"] = code.map { Int($0) } ?? NSNull()
        fields["signal"] = signal ?? NSNull()
        if encodeLine(fields) == nil {
            emit(["event": "error", "message": "the step's outputs were dropped: they do not fit one line"])
            fields["outputs"] = ""
        }
        emit(fields)
    }

    private func reply(_ id: Int, _ fields: [String: Any] = [:]) {
        var f = fields
        f["id"] = id
        f["ok"] = true
        emit(f)
    }

    private func refuse(_ id: Int, _ message: String) {
        emit(["id": id, "ok": false, "code": protocolErrorCode, "message": bounded(message)])
    }

    private func emit(_ fields: [String: Any]) {
        guard !closed, let line = encodeLine(fields) else { return }
        send(line)
    }
}

/// Lines, until a command announces raw bytes: then exactly that many bytes
/// as one item, then lines again. Pulled one item at a time, so that the
/// command announcing raw bytes is handled before what follows it is read.
public struct StreamReader {
    public enum Item: Equatable {
        case line(Data)
        case oversize
        case raw(Data)
    }

    private var buffer = Data()
    private var rawWanted = 0
    private var discarding = false

    public init() {}

    public mutating func append(_ data: Data) {
        buffer.append(data)
    }

    /// The next `count` bytes are raw.
    public mutating func expectRaw(_ count: Int) {
        rawWanted = count
    }

    /// The next whole item, or nil until more bytes arrive.
    public mutating func next() -> Item? {
        if rawWanted > 0 {
            guard buffer.count >= rawWanted else { return nil }
            let raw = Data(buffer.prefix(rawWanted))
            buffer = Data(buffer.dropFirst(rawWanted))
            rawWanted = 0
            return .raw(raw)
        }
        while true {
            guard let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) else {
                if buffer.count > maxLineBytes, !discarding {
                    // Too long already: report it once, and drop it up to its newline.
                    discarding = true
                    buffer = Data()
                    return .oversize
                }
                if discarding { buffer = Data() }
                return nil
            }
            let line = Data(buffer[buffer.startIndex..<newline])
            buffer = Data(buffer[buffer.index(after: newline)...])
            if discarding {
                discarding = false
                continue
            }
            return line.count > maxLineBytes ? .oversize : .line(line)
        }
    }
}
