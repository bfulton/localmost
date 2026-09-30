// The control protocol on stdio (contract §2.4): NDJSON commands in, events
// and answers out, and the state machine that ties them to the VM.
//
// Everything here runs on the main queue, which is also VZ's queue, so no
// method may block. The VM itself is behind the Machine protocol, so that
// the order of events and every stop path can be tested without booting one.

import Foundation

/// The most one line may hold, newline excluded: 64 KiB.
let maxLineBytes = 64 << 10

/// Splits a byte stream into lines. A line over the cap is reported once as
/// `oversize` and the rest of it, up to its newline, is dropped as it arrives,
/// so the buffer never grows much past the cap.
struct LineReader {
    enum Item: Equatable {
        case line(Data)
        case oversize
    }

    private var buffer = Data()
    private var discarding = false

    var buffered: Int { buffer.count }

    mutating func feed(_ data: Data) -> [Item] {
        var items: [Item] = []
        var rest = data[...]
        while let newline = rest.firstIndex(of: UInt8(ascii: "\n")) {
            let piece = rest[rest.startIndex..<newline]
            rest = rest[rest.index(after: newline)...]
            if discarding {
                discarding = false
                buffer.removeAll(keepingCapacity: true)
                continue
            }
            if buffer.count + piece.count > maxLineBytes {
                items.append(.oversize)
            } else {
                items.append(.line(buffer + piece))
            }
            buffer.removeAll(keepingCapacity: true)
        }
        if !discarding {
            if buffer.count + rest.count > maxLineBytes {
                items.append(.oversize)
                discarding = true
                buffer.removeAll(keepingCapacity: true)
            } else {
                buffer.append(contentsOf: rest)
            }
        }
        return items
    }
}

/// Why the VM stopped on its own.
enum MachineStopCause {
    /// The guest powered off.
    case guest
    /// VZ stopped the VM with an error (`didStopWithError`).
    case error(String)
}

/// The VM, as the controller drives it. Every call and callback is on the main queue.
protocol Machine: AnyObject {
    /// Set by the controller before `start`.
    var onStop: ((MachineStopCause) -> Void)? { get set }
    /// Starts the VM once; `done` gets nil on success.
    func start(_ done: @escaping (Error?) -> Void)
    /// Asks the guest to power off. False when it cannot be asked.
    func requestStop() -> Bool
    /// Stops the VM at once, as pulling the plug would.
    func forceStop(_ done: @escaping (Error?) -> Void)
}

/// What the controller needs from the process, injected so that tests can watch it.
struct ControllerHooks {
    /// Writes one encoded line, newline included, to stdout.
    var emit: (Data) -> Void
    /// Writes one log line to stderr: a level and a message.
    var log: (String, String) -> Void
    /// Milliseconds since the helper was exec'd.
    var startMs: () -> Int
    /// F_FULLFSYNC of the data disk, after a refresh VM's guest powered off.
    var syncDisk: () throws -> Void
    /// Runs a block on the main queue after some milliseconds.
    var after: (Int, @escaping () -> Void) -> Void
    /// Cleans up and exits with a code. Called exactly once.
    var finish: (Int32) -> Void
}

let maxGraceMs = 60000

/// The most a message in an event may hold, so that every event fits one line.
let maxMessageBytes = 2048

final class Controller {
    private enum State: String {
        case idle, starting, running, stopping, stopped
    }

    private let mode: Mode
    private let rosetta: String
    private let machine: Machine
    private let hooks: ControllerHooks
    private var state = State.idle
    /// A stop arrived while the VM was starting; carried out once it has.
    private var stopPending = false
    /// This side asked for the stop, so a guest power-off is `requested`.
    private var stopRequested = false
    private var forced = false

    init(mode: Mode, rosetta: String, machine: Machine, hooks: ControllerHooks) {
        self.mode = mode
        self.rosetta = rosetta
        self.machine = machine
        self.hooks = hooks
        machine.onStop = { [weak self] cause in self?.machineStopped(cause) }
    }

    /// Announces the sockets, runs the last checks, and starts the VM.
    func begin(dockerSocket: String, agentSocket: String, preStart: () throws -> Void) {
        guard state == .idle else { return }
        send(["event": "listening", "dockerSocket": dockerSocket, "agentSocket": agentSocket])
        do {
            try preStart()
        } catch let e as HelperError {
            return fail(e)
        } catch {
            return fail(HelperError(.vzStart, "\(error)"))
        }
        state = .starting
        machine.start { [weak self] error in self?.started(error) }
    }

    private func started(_ error: Error?) {
        guard state == .starting else { return }
        if let error = error {
            return fail(HelperError(.vzStart, describe(error)))
        }
        state = .running
        send(["event": "started", "pid": Int(getpid()), "rosetta": rosetta, "startMs": hooks.startMs()])
        hooks.log("info", "VM started")
        if stopPending {
            // Too early for the guest to act on a request: force it.
            stop(graceMs: 0)
        }
    }

    /// Ends the helper with an error, before or after the VM started.
    func fail(_ e: HelperError) {
        guard state != .stopped else { return }
        state = .stopped
        hooks.log("error", e.message)
        send(["event": "stopped", "reason": "error", "code": e.code.rawValue, "message": bounded(e.message), "synced": false])
        hooks.finish(e.code.exitCode)
    }

    // MARK: - Stopping

    func parentGone() {
        hooks.log("warn", "the parent process exited: stopping the VM")
        stop(graceMs: 0)
    }

    func inputClosed() {
        hooks.log("info", "stdin closed: stopping the VM")
        stop(graceMs: 0)
    }

    func signalled(_ name: String) {
        hooks.log("info", "\(name): stopping the VM")
        stop(graceMs: 0)
    }

    private func stop(graceMs: Int) {
        switch state {
        case .idle:
            // Before the VM exists there is nothing to stop.
            state = .stopped
            send(["event": "stopped", "reason": "requested", "synced": false])
            hooks.finish(cleanExitCode)
        case .starting:
            stopPending = true
        case .running:
            state = .stopping
            stopRequested = true
            if graceMs > 0, machine.requestStop() {
                hooks.after(graceMs) { [weak self] in self?.force() }
            } else {
                force()
            }
        case .stopping:
            if graceMs == 0 { force() }
        case .stopped:
            break
        }
    }

    private func force() {
        guard state == .stopping, !forced else { return }
        forced = true
        machine.forceStop { [weak self] error in
            guard let self = self else { return }
            if let error = error {
                self.fail(HelperError(.guestError, "the VM could not be stopped: \(describe(error))"))
            } else {
                self.finishStop(guest: false)
            }
        }
    }

    private func machineStopped(_ cause: MachineStopCause) {
        switch cause {
        case .guest:
            finishStop(guest: !stopRequested)
        case .error(let message):
            fail(HelperError(.guestError, message))
        }
    }

    private func finishStop(guest: Bool) {
        guard state == .running || state == .stopping else { return }
        var synced = false
        if guest, case .refresh = mode {
            do {
                try hooks.syncDisk()
                synced = true
            } catch let e as HelperError {
                return fail(e)
            } catch {
                return fail(HelperError(.sync, "\(error)"))
            }
        }
        state = .stopped
        send(["event": "stopped", "reason": guest ? "guest" : "requested", "synced": synced])
        hooks.log("info", "VM stopped (\(guest ? "guest" : "requested"))")
        hooks.finish(cleanExitCode)
    }

    // MARK: - Commands

    func handle(_ item: LineReader.Item) {
        guard case .line(let data) = item else {
            hooks.log("warn", "a command line over \(maxLineBytes) bytes was dropped")
            return
        }
        guard let object = try? JSONSerialization.jsonObject(with: data), let command = object as? [String: Any] else {
            hooks.log("warn", "a command that is not a JSON object was dropped")
            return
        }
        guard let idNumber = command["id"] as? NSNumber, isInteger(idNumber) else {
            hooks.log("warn", "a command without an integer id was dropped")
            return
        }
        let id = idNumber.intValue
        guard let v = command["v"] as? NSNumber, isInteger(v), v.intValue == 1 else {
            return refuse(id, "unsupported protocol version")
        }
        switch command["op"] as? String {
        case "ping":
            send(["id": id, "ok": true, "state": pingState])
        case "stop":
            guard let grace = command["graceMs"] as? NSNumber, isInteger(grace), (0...maxGraceMs).contains(grace.intValue) else {
                return refuse(id, "stop needs graceMs from 0 to \(maxGraceMs)")
            }
            send(["id": id, "ok": true])
            stop(graceMs: grace.intValue)
        default:
            refuse(id, "unknown command")
        }
    }

    private var pingState: String {
        switch state {
        case .idle, .starting: return "starting"
        case .running: return "running"
        case .stopping, .stopped: return "stopping"
        }
    }

    private func refuse(_ id: Int, _ message: String) {
        hooks.log("warn", "command \(id) refused: \(message)")
        send(["id": id, "ok": false, "code": protocolErrorCode, "message": message])
    }

    private func send(_ fields: [String: Any]) {
        var object = fields
        object["v"] = 1
        guard var line = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) else {
            return hooks.log("error", "an event could not be encoded")
        }
        line.append(UInt8(ascii: "\n"))
        hooks.emit(line)
    }
}

/// A message cut to fit an event, on a character boundary.
func bounded(_ message: String) -> String {
    guard message.utf8.count > maxMessageBytes else { return message }
    var out = ""
    for c in message {
        if out.utf8.count + String(c).utf8.count > maxMessageBytes - 3 { break }
        out.append(c)
    }
    return out + "..."
}

/// An error as one line: its description, domain and code, and those of the
/// errors under it. VZ reports a share its sandbox refused as an invalid
/// configuration; the EPERM that says why is the underlying error.
func describe(_ error: Error) -> String {
    var parts: [String] = []
    var next: NSError? = error as NSError
    while let ns = next, parts.count < 4 {
        parts.append("\(ns.localizedDescription) (\(ns.domain) \(ns.code))")
        next = ns.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return parts.joined(separator: " <- ")
}
