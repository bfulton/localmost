// The state machine of every command that runs a VM - `provision`,
// `save-state` and `run` - and its control protocol on stdio: NDJSON
// commands in (`ping`, `stop`), events out, one `end` last.
//
// Everything here runs on the main queue, which is also VZ's queue, so no
// method may block. The VM is behind the Machine protocol, so that the order
// of events, the restore fallback, the save and every stop path can be
// tested without booting macOS.

import Foundation

/// Why the VM stopped on its own.
public enum MachineStopCause: Equatable {
    /// The guest powered off.
    case guest
    /// VZ stopped the VM with an error.
    case error(String)
}

/// The VM, as the controller drives it. Every call and callback is on the main queue.
public protocol Machine: AnyObject {
    /// Set by the controller before it starts the VM.
    var onStop: ((MachineStopCause) -> Void)? { get set }
    /// A cold boot; `done` gets nil once the VM runs.
    func start(_ done: @escaping (Error?) -> Void)
    /// Restores a saved state and resumes it; `done` gets nil once the VM
    /// runs. After a failure the machine can still `start` cold.
    func restore(from path: String, _ done: @escaping (Error?) -> Void)
    /// Pauses the VM and saves its state to `path`. The VM stays paused.
    func pauseAndSave(to path: String, _ done: @escaping (Error?) -> Void)
    /// Asks the guest to power off. False when it cannot be asked.
    func requestStop() -> Bool
    /// Stops the VM at once, as pulling the plug would.
    func forceStop(_ done: @escaping (Error?) -> Void)
}

/// How the controller starts the VM.
public enum StartPlan: Equatable {
    case cold
    /// Restore this state, falling back to a cold boot when VZ refuses it.
    case restore(String)
}

/// What the process gives the controller beyond Hooks.
public struct ControllerHooks {
    public var hooks: Hooks
    /// Milliseconds since the helper was exec'd.
    public var startMs: () -> Int
    /// Runs a block on the main queue after some milliseconds.
    public var after: (Int, @escaping () -> Void) -> Void

    public init(hooks: Hooks, startMs: @escaping () -> Int, after: @escaping (Int, @escaping () -> Void) -> Void) {
        self.hooks = hooks
        self.startMs = startMs
        self.after = after
    }
}

public let maxGraceMs = 60000

/// How long a stop that arrived during start waits for start to finish.
/// After that the helper ends, and VZ tears the VM down with it, so that a
/// hung start never outlives Electron.
public let startStopDeadlineMs = 15000

public final class Controller {
    private enum State: String {
        case idle, starting, running, saving, stopping, stopped
    }

    private let machine: Machine
    private let ch: ControllerHooks
    private var state = State.idle
    private var stopPending = false
    private var stopRequested = false
    private var forced = false
    /// How the VM came up: `cold`, `restore`, or `cold` after a refused restore.
    public private(set) var booted: String?
    /// Fields every `started` event carries besides the boot.
    private var startedFields: [String: Any] = [:]
    /// Run once the VM runs, before `started` is sent.
    private var onRunning: (() -> Void)?

    public init(machine: Machine, hooks: ControllerHooks) {
        self.machine = machine
        self.ch = hooks
        machine.onStop = { [weak self] cause in self?.machineStopped(cause) }
    }

    private var hooks: Hooks { ch.hooks }

    /// Runs the last checks and starts the VM by `plan`.
    public func begin(_ plan: StartPlan, startedFields: [String: Any] = [:], preStart: () throws -> Void = {},
                      onRunning: (() -> Void)? = nil) {
        guard state == .idle else { return }
        self.startedFields = startedFields
        self.onRunning = onRunning
        do {
            try preStart()
        } catch let e as HelperError {
            return fail(e)
        } catch {
            return fail(HelperError(.vzStart, describe(error)))
        }
        state = .starting
        switch plan {
        case .cold:
            machine.start { [weak self] error in self?.started(error, boot: "cold") }
        case .restore(let path):
            machine.restore(from: path) { [weak self] error in
                guard let self = self, self.state == .starting else { return }
                guard let error = error else {
                    return self.started(nil, boot: "restore")
                }
                // The state is only an accelerator: a refused one costs a
                // cold boot, never the job.
                self.hooks.send(["event": "restore", "ok": false, "message": bounded(describe(error))])
                self.hooks.log("warn", "the saved state was refused, booting cold: \(describe(error))")
                if self.stopPending {
                    return self.finishStop(guest: false)
                }
                self.machine.start { [weak self] error in self?.started(error, boot: "cold") }
            }
        }
    }

    private func started(_ error: Error?, boot: String) {
        guard state == .starting else { return }
        if let error = error {
            return fail(HelperError(.vzStart, describe(error)))
        }
        state = .running
        booted = boot
        onRunning?()
        var fields = startedFields
        fields["event"] = "started"
        fields["pid"] = Int(getpid())
        fields["boot"] = boot
        fields["startMs"] = ch.startMs()
        hooks.send(fields)
        hooks.log("info", "VM started (\(boot))")
        if stopPending {
            stop(graceMs: 0)
        }
    }

    /// Pauses the running VM and saves its state through `save`, which
    /// writes the state file and its stamp; then stops the VM and ends.
    public func saveAndStop(to path: String, commit: @escaping () throws -> Void) {
        guard state == .running else { return }
        state = .saving
        machine.pauseAndSave(to: path) { [weak self] error in
            guard let self = self, self.state == .saving else { return }
            if let error = error {
                return self.fail(HelperError(.state, "the machine state could not be saved: \(describe(error))"))
            }
            do {
                try commit()
            } catch let e as HelperError {
                return self.fail(e)
            } catch {
                return self.fail(HelperError(.state, describe(error)))
            }
            self.hooks.send(["event": "saved"])
            self.state = .stopping
            self.stopRequested = true
            self.force(reason: "done")
        }
    }

    /// Ends the helper with an error, before or after the VM started.
    public func fail(_ e: HelperError) {
        guard state != .stopped else { return }
        let wasRunning = state == .running || state == .saving || state == .stopping
        state = .stopped
        if wasRunning {
            // Leave nothing running behind the helper: VZ's process outlives it.
            machine.forceStop { _ in }
        }
        hooks.end(e, reason: "error")
    }

    // MARK: - Stopping

    public func parentGone() {
        hooks.log("warn", "the parent process exited: stopping the VM")
        stop(graceMs: 0)
    }

    public func inputClosed() {
        hooks.log("info", "stdin closed: stopping the VM")
        stop(graceMs: 0)
    }

    public func signalled(_ name: String) {
        hooks.log("info", "\(name): stopping the VM")
        stop(graceMs: 0)
    }

    private func stop(graceMs: Int) {
        switch state {
        case .idle:
            state = .stopped
            hooks.end(nil, reason: "requested")
        case .starting:
            guard !stopPending else { return }
            stopPending = true
            ch.after(startStopDeadlineMs) { [weak self] in self?.abandonStart() }
        case .running:
            state = .stopping
            stopRequested = true
            if graceMs > 0, machine.requestStop() {
                ch.after(graceMs) { [weak self] in self?.force(reason: "requested") }
            } else {
                force(reason: "requested")
            }
        case .saving:
            // The save finishes or fails on its own; a stop then stops it.
            stopPending = true
        case .stopping:
            if graceMs == 0 { force(reason: "requested") }
        case .stopped:
            break
        }
    }

    private func abandonStart() {
        guard state == .starting else { return }
        state = .stopped
        hooks.log("warn", "the VM's start did not finish within \(startStopDeadlineMs) ms of the stop: exiting")
        hooks.end(nil, reason: "requested")
    }

    private func force(reason: String) {
        guard state == .stopping, !forced else { return }
        forced = true
        machine.forceStop { [weak self] error in
            guard let self = self else { return }
            if let error = error {
                self.fail(HelperError(.guestError, "the VM could not be stopped: \(describe(error))"))
            } else {
                self.finish(reason: reason)
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
        guard state == .running || state == .stopping || state == .starting || state == .saving else { return }
        finish(reason: guest ? "guest" : "requested")
    }

    private func finish(reason: String) {
        guard state != .stopped else { return }
        state = .stopped
        hooks.log("info", "VM stopped (\(reason))")
        hooks.end(nil, reason: reason)
    }

    // MARK: - Commands

    public func handle(_ item: LineReader.Item) {
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
        guard let v = command["v"] as? NSNumber, isInteger(v), v.intValue == protocolVersion else {
            return refuse(id, "unsupported protocol version")
        }
        switch command["op"] as? String {
        case "ping":
            hooks.send(["id": id, "ok": true, "state": pingState])
        case "stop":
            guard let grace = command["graceMs"] as? NSNumber, isInteger(grace), (0...maxGraceMs).contains(grace.intValue) else {
                return refuse(id, "stop needs graceMs from 0 to \(maxGraceMs)")
            }
            hooks.send(["id": id, "ok": true])
            stop(graceMs: grace.intValue)
        default:
            refuse(id, "unknown command")
        }
    }

    private var pingState: String {
        switch state {
        case .idle, .starting: return "starting"
        case .running: return "running"
        case .saving: return "saving"
        case .stopping, .stopped: return "stopping"
        }
    }

    private func refuse(_ id: Int, _ message: String) {
        hooks.log("warn", "command \(id) refused: \(message)")
        hooks.send(["id": id, "ok": false, "code": protocolErrorCode, "message": message])
    }
}
