// The process around every command: stdout events, stderr log lines, and
// the watches that stop a command - its parent exiting, stdin closing,
// SIGTERM or SIGINT - each with no grace.

import Foundation
import MacVMCore

/// The helper's own version.
let helperVersion = "1.0.0"

/// The interface contract this helper implements with Electron
/// (docs/roadmap/macos-vm-jobs.md, "The helper").
let contractVersion = 1

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

/// The process's hooks: events to stdout until nobody reads them, then the
/// command is told its parent is gone; `finish` runs `cleanup` and exits.
final class ProcessHooks {
    private var outputBroken = false
    var onOutputBroken: (() -> Void)?
    var cleanup: [() -> Void] = []

    lazy var hooks = Hooks(
        emit: { [weak self] line in
            guard let self = self, !self.outputBroken else { return }
            if !writeAll(1, line) {
                self.outputBroken = true
                DispatchQueue.main.async { self.onOutputBroken?() }
            }
        },
        log: logLine,
        finish: { [weak self] code in
            self?.cleanup.forEach { $0() }
            exit(code)
        }
    )

    var controllerHooks: ControllerHooks {
        ControllerHooks(hooks: hooks, startMs: millisecondsSinceExec, after: { ms, block in
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms), execute: block)
        })
    }
}

/// What the watches stop.
protocol Stoppable: AnyObject {
    func parentGone()
    func inputClosed()
    func signalled(_ name: String)
    /// One complete stdin line, or an oversize one.
    func command(_ item: LineReader.Item)
}

/// Starts the parent watch, the stdin reader and the signal handlers. The
/// returned objects must be kept for the life of the command.
func watch(_ target: Stoppable, ppid: pid_t) -> [AnyObject] {
    var kept: [AnyObject] = []
    let parent = ParentWatch(pid: ppid, queue: .main, stillThere: { getppid() == ppid }) { [weak target] in
        target?.parentGone()
    }
    parent.start()
    kept.append(parent)

    var lines = LineReader()
    let input = InputReader(fd: 0, queue: .main, onData: { [weak target] data in
        let items = lines.feed(data)
        items.forEach { target?.command($0) }
    }, onEOF: { [weak target] in
        target?.inputClosed()
    })
    input.start()
    kept.append(input)

    for (sig, name) in [(SIGTERM, "SIGTERM"), (SIGINT, "SIGINT")] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { [weak target] in target?.signalled(name) }
        source.activate()
        kept.append(source as AnyObject)
    }
    return kept
}

/// Ends a command that failed before it could start anything: logged, and
/// reported as its last event, the way every other failure is.
func failEarly(_ e: HelperError) -> Never {
    let hooks = Hooks(emit: { writeAll(1, $0) }, log: logLine, finish: { exit($0) })
    hooks.end(e, reason: "error")
    exit(e.code.exitCode)
}

/// What must live as long as the process: the watches, listeners and windows.
var retained: [Any] = []

/// Keeps `objects` and runs the main queue until the command exits.
func runMain(keeping objects: Any...) -> Never {
    retained.append(contentsOf: objects)
    dispatchMain()
}
