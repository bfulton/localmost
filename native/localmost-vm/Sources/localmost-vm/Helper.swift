// One run of the helper: the checks, the VM, its sockets, and the watches
// that stop it (contract §2). The order is fixed:
//
//   parent check, paths, pid file, guest sizes, data disk, share checks,
//   console, configuration and validate(), the two unix sockets,
//   `listening`, the share checks again, start, `started`.
//
// Any failure before `started` ends the helper with its code and a `stopped`
// event that says why. After that, the VM runs until the guest powers off, a
// `stop` arrives, the parent exits, stdin closes, or SIGTERM/SIGINT.

import Foundation
import Virtualization

/// The helper's own version.
let helperVersion = "1.0.0"

/// The interface contract this helper implements (docs/roadmap/vm-docker-backend-contract.md).
let contractVersion = 1

final class Helper {
    private let args: RunArgs
    private let ppid = getppid()
    private var controller: Controller!
    private var machine: VZMachine?
    private var listeners: [UnixListener] = []
    private var console: ConsoleLog?
    private var consolePipe: Pipe?
    private var parentWatch: ParentWatch?
    private var signalSources: [DispatchSourceSignal] = []
    private var lines = LineReader()
    private var outputBroken = false

    init(_ args: RunArgs) {
        self.args = args
    }

    /// Ends the helper for a failure that happened before the VM could be
    /// built: logged, and reported as the last event, the way every other
    /// failure is.
    static func failEarly(_ e: HelperError) -> Never {
        Controller(mode: .refresh(repoKey: ""), rosetta: "off", machine: NoMachine(), hooks: ControllerHooks(
            emit: { writeAll(1, $0) }, log: logLine, startMs: { 0 }, syncDisk: {}, after: { _, _ in }, finish: { exit($0) }
        )).fail(e)
        exit(e.code.exitCode)
    }

    func run() -> Never {
        let paths: HelperPaths
        let guest: GuestArtifacts
        var share: CheckedShare?
        let rosetta: RosettaPlan
        let configuration: VZVirtualMachineConfiguration
        do {
            try checkParent(ppid)
            paths = try HelperPaths(args)
            try writePidFile(paths.pidFile)
            guest = try checkGuestImage(resources: args.resources)
            try checkDataDisk(paths.dataDisk)
            if case .job(let sandboxId, _) = args.mode {
                share = try validateShare(dataDir: paths.dataDir, sandboxId: sandboxId, sameDeviceAs: paths.vmDir)
            }
            console = try ConsoleLog(path: paths.consoleLog)
            let pipe = Pipe()
            consolePipe = pipe
            let job: Bool
            if case .job = args.mode { job = true } else { job = false }
            rosetta = rosettaPlan(args.rosetta, job: job, vzRosettaAvailability)
            configuration = try makeConfiguration(
                VMSpec(mode: args.mode, guest: guest, dataDisk: paths.dataDisk, share: share?.path, cpus: args.cpus, memoryMiB: args.memoryMiB),
                console: pipe.fileHandleForWriting,
                rosetta: rosetta.share ? try rosettaDevice() : nil
            )
            do {
                try configuration.validate()
            } catch {
                throw HelperError(.vzConfig, "the VM configuration is not valid: \(describe(error))")
            }
        } catch let e as HelperError {
            Helper.failEarly(e)
        } catch {
            Helper.failEarly(HelperError(.vzConfig, describe(error)))
        }

        var proxyPort: Int?
        if case .job(_, let port) = args.mode { proxyPort = port }
        let machine = VZMachine(configuration: configuration, proxyPort: proxyPort, log: logLine)
        self.machine = machine
        controller = Controller(mode: args.mode, rosetta: rosetta.report, machine: machine, hooks: hooks(paths))

        startConsole()
        do {
            listeners = [
                try UnixListener(path: paths.dockerSocket, maxConnections: maxConnectionsPerSocket) { conn in
                    machine.dial(GuestPort.docker, for: conn)
                },
                try UnixListener(path: paths.agentSocket, maxConnections: maxConnectionsPerSocket) { conn in
                    machine.dial(GuestPort.agent, for: conn)
                },
            ]
        } catch let e as HelperError {
            controller.fail(e)
        } catch {
            controller.fail(HelperError(.socket, describe(error)))
        }

        watch()
        controller.begin(dockerSocket: paths.dockerSocket, agentSocket: paths.agentSocket) {
            // Right before start: the share must still be the directory checked above.
            if case .job(let sandboxId, _) = args.mode, let share = share {
                try recheckShare(share, dataDir: paths.dataDir, sandboxId: sandboxId, sameDeviceAs: paths.vmDir)
            }
        }
        dispatchMain()
    }

    private func hooks(_ paths: HelperPaths) -> ControllerHooks {
        ControllerHooks(
            emit: { [weak self] line in
                guard let self = self, !self.outputBroken else { return }
                if !writeAll(1, line) {
                    // Nobody reads the events any more: the parent is gone.
                    self.outputBroken = true
                    DispatchQueue.main.async { self.controller.parentGone() }
                }
            },
            log: logLine,
            startMs: millisecondsSinceExec,
            syncDisk: { try fullSync(paths.dataDisk) },
            after: { ms, block in DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms), execute: block) },
            finish: { [weak self] code in
                self?.listeners.forEach { $0.close() }
                exit(code)
            }
        )
    }

    /// The parent, stdin and the signals: each stops the VM with no grace.
    private func watch() {
        let ppid = self.ppid
        let watch = ParentWatch(pid: ppid, queue: .main, stillThere: { getppid() == ppid }) { [weak self] in
            self?.controller.parentGone()
        }
        parentWatch = watch
        watch.start()

        InputReader(fd: 0, queue: .main, onData: { [weak self] data in
            guard let self = self else { return }
            var reader = self.lines
            let items = reader.feed(data)
            self.lines = reader
            items.forEach { self.controller.handle($0) }
        }, onEOF: { [weak self] in
            self?.controller.inputClosed()
        }).start()

        for (sig, name) in [(SIGTERM, "SIGTERM"), (SIGINT, "SIGINT")] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in self?.controller.signalled(name) }
            source.activate()
            signalSources.append(source)
        }
    }

    /// The guest's console, into console.log, read off the main queue.
    private func startConsole() {
        guard let pipe = consolePipe, let console = console else { return }
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
            } else {
                console.append(data)
            }
        }
    }
}

/// The VM that never was: for reporting a failure before one existed.
private final class NoMachine: Machine {
    var onStop: ((MachineStopCause) -> Void)?
    func start(_ done: @escaping (Error?) -> Void) {}
    func requestStop() -> Bool { false }
    func forceStop(_ done: @escaping (Error?) -> Void) { done(nil) }
}

/// `helper.pid`, the helper's pid and a newline, for the startup sweep.
func writePidFile(_ path: String) throws {
    let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else {
        throw HelperError(.args, "\(path): \(posixMessage())")
    }
    defer { close(fd) }
    guard writeAll(fd, Data("\(getpid())\n".utf8)) else {
        throw HelperError(.args, "\(path): \(posixMessage())")
    }
}

/// F_FULLFSYNC of the data disk: the refresh's disk is on stable storage
/// before Electron promotes it to the golden disk.
func fullSync(_ path: String) throws {
    let fd = open(path, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else {
        throw HelperError(.sync, "\(path): \(posixMessage())")
    }
    defer { close(fd) }
    guard fcntl(fd, F_FULLFSYNC) == 0 else {
        throw HelperError(.sync, "F_FULLFSYNC \(path): \(posixMessage())")
    }
}

/// Writes every byte, or reports that it could not.
@discardableResult
func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { raw in
        var off = 0
        while off < raw.count {
            let n = write(fd, raw.baseAddress! + off, raw.count - off)
            if n < 0, errno == EINTR { continue }
            if n <= 0 { return false }
            off += n
        }
        return true
    }
}

/// A stderr line: `<level> <message>`, on one line whatever the message holds.
func logLine(_ level: String, _ message: String) {
    let flat = message.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }.joined()
    writeAll(2, Data("\(level) \(flat)\n".utf8))
}

/// Milliseconds since this process was exec'd, from its kernel start time.
func millisecondsSinceExec() -> Int {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.size
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return 0 }
    let start = info.kp_proc.p_un.__p_starttime
    var now = timeval()
    gettimeofday(&now, nil)
    let ms = (Int(now.tv_sec) - Int(start.tv_sec)) * 1000 + (Int(now.tv_usec) - Int(start.tv_usec)) / 1000
    return max(ms, 0)
}
