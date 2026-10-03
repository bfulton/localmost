// The guest, as the agent changes it: the clock, the entropy pool, the
// loopback relays, the runner versions, and the one job's runner, started as
// the job user in that user's login session.

import CryptoKit
import Darwin
import Foundation
import MacVMAgentCore
import MacVMCore

/// Where a job's runner runs: a copy of its version, the job user's.
let jobRunnerDir = jobUserHome + "/actions-runner"

final class GuestSystem: AgentSystem {
    private let log: (String) -> Void
    private var relayListeners: [DispatchSourceRead] = []
    private var job: Job?
    private let lock = NSLock()

    init(log: @escaping (String) -> Void) {
        self.log = log
    }

    func installedRunnerVersions() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: runnerRoot)) ?? []
        return names.filter { isRunnerVersion($0) && FileManager.default.isExecutableFile(atPath: "\(runnerRoot)/\($0)/run.sh") }
    }

    func osVersion() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return versionString(major: v.majorVersion, minor: v.minorVersion, patch: v.patchVersion)
    }

    func setupDone() -> Bool {
        FileManager.default.fileExists(atPath: setupMarker) && getpwnam(jobUser) != nil && !installedRunnerVersions().isEmpty
    }

    func setTime(ms: Int64) throws {
        var tv = timeval(tv_sec: Int(ms / 1000), tv_usec: Int32((ms % 1000) * 1000))
        guard settimeofday(&tv, nil) == 0 else {
            throw ProtocolError("the clock cannot be set: \(posixMessage())")
        }
    }

    func addEntropy(_ bytes: Data) throws {
        // Written to /dev/random, the kernel mixes it into its pool: a guest
        // restored from a saved state otherwise starts every job from the
        // same pool.
        let fd = open("/dev/random", O_WRONLY | O_CLOEXEC)
        guard fd >= 0 else { throw ProtocolError("/dev/random cannot be opened: \(posixMessage())") }
        defer { close(fd) }
        guard writeAll(fd, bytes) else { throw ProtocolError("/dev/random cannot be written: \(posixMessage())") }
    }

    func startRelays(proxyPort: Int, brokerPort: Int) throws {
        for (local, hostPort) in [(proxyPort, AgentPorts.hostProxy), (brokerPort, AgentPorts.hostBroker)] {
            let fd: Int32
            do {
                fd = try loopbackListen(port: local)
            } catch let e as POSIXError {
                throw ProtocolError("127.0.0.1:\(local) cannot be listened on: \(e.message)")
            }
            _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .global())
            source.setEventHandler { [log] in
                while true {
                    let conn = accept(fd, nil, nil)
                    if conn < 0 { return }
                    _ = fcntl(conn, F_SETFD, FD_CLOEXEC)
                    _ = fcntl(conn, F_SETFL, fcntl(conn, F_GETFL) & ~O_NONBLOCK)
                    do {
                        let vsock = try vsockConnectHost(port: hostPort)
                        Relay(Relay.End(fd: conn, close: { close(conn) }), Relay.End(fd: vsock, close: { close(vsock) }),
                              label: "\(local)").start()
                    } catch {
                        log("relay from 127.0.0.1:\(local) to the host failed: \(describe(error))")
                        close(conn)
                    }
                }
            }
            source.activate()
            relayListeners.append(source)
        }
    }

    func installRunner(_ upload: RunnerUpload, bytes: Data) throws {
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard digest == upload.sha256, bytes.count == upload.bytes else {
            throw ProtocolError("the runner's bytes do not match their sha256")
        }
        let staging = "\(runnerRoot)/.staging-\(upload.version)"
        let archive = "\(runnerRoot)/.upload-\(upload.version).tar.gz"
        try? FileManager.default.createDirectory(atPath: runnerRoot, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o755])
        try? FileManager.default.removeItem(atPath: staging)
        try FileManager.default.createDirectory(atPath: staging, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o755])
        guard FileManager.default.createFile(atPath: archive, contents: bytes, attributes: [.posixPermissions: 0o600]) else {
            throw ProtocolError("the runner archive cannot be written")
        }
        defer { try? FileManager.default.removeItem(atPath: archive) }
        try runChecked(["/usr/bin/tar", "-xzf", archive, "-C", staging])
        try runChecked(["/usr/sbin/chown", "-R", "root:wheel", staging])
        try runChecked(["/bin/chmod", "-R", "go-w", staging])
        guard rename(staging, "\(runnerRoot)/\(upload.version)") == 0 else {
            throw ProtocolError("the runner cannot be put in place: \(posixMessage())")
        }
    }

    func startJob(_ spec: JobSpec, output: @escaping (String, String) -> Void,
                  exit: @escaping (Int32?, String?) -> Void) throws -> Int32 {
        guard let pw = getpwnam(jobUser) else { throw ProtocolError("the job user \(jobUser) does not exist") }
        let uid = pw.pointee.pw_uid
        let gid = pw.pointee.pw_gid
        try? FileManager.default.removeItem(atPath: jobRunnerDir)
        // A clone of the runner, so the job writes its _diag and _work into
        // its own copy and never into root's.
        try runChecked(["/bin/cp", "-cR", "\(runnerRoot)/\(spec.runnerVersion)", jobRunnerDir])
        for (name, text) in spec.files {
            let path = jobRunnerDir + "/" + name
            guard FileManager.default.createFile(atPath: path, contents: Data(text.utf8), attributes: [.posixPermissions: 0o600]) else {
                throw ProtocolError("\(name) cannot be written")
            }
        }
        let tmp = jobUserHome + "/tmp"
        try? FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try runChecked(["/usr/sbin/chown", "-R", "\(uid):\(gid)", jobRunnerDir, tmp])

        let env = runnerEnvironment(spec, home: jobUserHome)
        let argv = execAsArgv(uid: uid, agent: agentInstallPath, dir: jobRunnerDir, program: jobRunnerDir + "/run.sh", args: spec.args)
        let job = try Job.spawn(argv: argv, env: env, uid: uid, output: output, exit: exit)
        lock.lock()
        self.job = job
        lock.unlock()
        return job.pid
    }

    func signalJob(_ signal: JobSignal) {
        lock.lock()
        let job = self.job
        lock.unlock()
        guard let job = job else { return }
        kill(-job.pid, signal.number)
        if signal == .KILL {
            killAllJobUserProcesses()
        }
    }
}

/// Kills every process of the job user: the job's strays that left its
/// process group. Done by the agent's own `kill-all`, which becomes the job
/// user first, so that kill(-1) reaches exactly that user's processes and
/// nothing of root's.
func killAllJobUserProcesses() {
    _ = try? runChecked([CommandLine.arguments[0], "kill-all", "--user", jobUser])
}

/// The job's runner process and its output.
final class Job {
    let pid: Int32
    let uid: uid_t
    private var sources: [DispatchSourceRead] = []

    private init(pid: Int32, uid: uid_t) {
        self.pid = pid
        self.uid = uid
    }

    static func spawn(argv: [String], env: [String: String], uid: uid_t, output: @escaping (String, String) -> Void,
                      exit: @escaping (Int32?, String?) -> Void) throws -> Job {
        var out: [Int32] = [0, 0]
        var err: [Int32] = [0, 0]
        guard pipe(&out) == 0, pipe(&err) == 0 else { throw ProtocolError("pipes cannot be made: \(posixMessage())") }
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, out[1], 1)
        posix_spawn_file_actions_adddup2(&actions, err[1], 2)
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // Its own process group, so a signal reaches the whole job.
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_setpgroup(&attr, 0)
        let cArgs = argv.map { strdup($0) } + [nil]
        let cEnv = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            cArgs.forEach { free($0) }
            cEnv.forEach { free($0) }
        }
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, argv[0], &actions, &attr, cArgs, cEnv)
        close(out[1])
        close(err[1])
        guard rc == 0 else {
            close(out[0])
            close(err[0])
            throw ProtocolError("the runner cannot be started: \(String(cString: strerror(rc)))")
        }
        let job = Job(pid: pid, uid: uid)
        let group = DispatchGroup()
        for (fd, stream) in [(out[0], "stdout"), (err[0], "stderr")] {
            group.enter()
            job.sources.append(readLines(fd: fd, onLine: { output(stream, $0) }, onEnd: { group.leave() }))
        }
        DispatchQueue.global().async {
            var status: Int32 = 0
            while waitpid(pid, &status, 0) < 0, errno == EINTR {}
            group.wait()
            let termSig = status & 0x7f
            if termSig == 0 {
                exit((status >> 8) & 0xff, nil)
            } else {
                exit(nil, signalName(termSig))
            }
        }
        return job
    }
}

/// The most of one output line passed on; the rest is cut.
let maxOutputLine = 16 << 10

private func readLines(fd: Int32, onLine: @escaping (String) -> Void, onEnd: @escaping () -> Void) -> DispatchSourceRead {
    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue(label: "job output \(fd)"))
    var pending = Data()
    source.setEventHandler {
        var buf = [UInt8](repeating: 0, count: 64 << 10)
        let n = read(fd, &buf, buf.count)
        if n <= 0 {
            if !pending.isEmpty { onLine(String(decoding: pending.prefix(maxOutputLine), as: UTF8.self)) }
            pending = Data()
            source.cancel()
            return
        }
        pending.append(contentsOf: buf[0..<n])
        while let nl = pending.firstIndex(of: UInt8(ascii: "\n")) {
            onLine(String(decoding: pending[pending.startIndex..<nl].prefix(maxOutputLine), as: UTF8.self))
            pending = Data(pending[pending.index(after: nl)...])
        }
        if pending.count > maxOutputLine {
            onLine(String(decoding: pending.prefix(maxOutputLine), as: UTF8.self))
            pending = Data()
        }
    }
    source.setCancelHandler {
        close(fd)
        onEnd()
    }
    source.activate()
    return source
}

func signalName(_ sig: Int32) -> String {
    switch sig {
    case SIGTERM: return "SIGTERM"
    case SIGKILL: return "SIGKILL"
    case SIGINT: return "SIGINT"
    case SIGHUP: return "SIGHUP"
    case SIGSEGV: return "SIGSEGV"
    case SIGABRT: return "SIGABRT"
    default: return "SIG\(sig)"
    }
}

/// Runs a program to completion; a non-zero exit is an error naming it.
@discardableResult
func runChecked(_ argv: [String], stdin: Data? = nil) throws -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: argv[0])
    p.arguments = Array(argv.dropFirst())
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    let input = Pipe()
    p.standardInput = stdin == nil ? FileHandle.nullDevice : input
    try p.run()
    if let stdin = stdin {
        input.fileHandleForWriting.write(stdin)
        try? input.fileHandleForWriting.close()
    }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    let text = String(decoding: data, as: UTF8.self)
    guard p.terminationStatus == 0 else {
        throw ProtocolError("\((argv[0] as NSString).lastPathComponent) exited \(p.terminationStatus): \(text.suffix(400))")
    }
    return text
}
