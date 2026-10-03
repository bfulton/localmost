// Parent death, as native/localmost-vm handles it (its contract §2.4), copied
// from there. The helper records its parent at start and
// watches it with kqueue (EVFILT_PROC, NOTE_EXIT); it also treats EOF on
// stdin as the parent gone. Either one stops the VM with no grace. That is
// what stops every VM when Electron main crashes or is SIGKILLed: nothing
// else would, because the VM runs in VZ's own XPC process, which does not
// die with Electron.

import Foundation

/// Refuses to run as an orphan: a helper whose parent is already launchd
/// has nobody to watch, and would run its VM until the guest stopped.
public func checkParent(_ ppid: pid_t) throws {
    guard ppid > 1 else {
        throw HelperError(.args, "the helper's parent has already exited (parent pid \(ppid))")
    }
}

/// Calls `gone` once, on `queue`, when the process `pid` exits.
public final class ParentWatch {
    private let pid: pid_t
    private let queue: DispatchQueue
    private let stillThere: () -> Bool
    private let gone: () -> Void
    private var source: DispatchSourceProcess?
    private var fired = false

    /// `stillThere` closes the race between recording the parent and
    /// registering the watch: a parent that exited in between is never
    /// reported by kqueue, so it is checked once the watch is in place. The
    /// helper passes `getppid() == recorded`, since an orphan is reparented
    /// to launchd.
    public init(pid: pid_t, queue: DispatchQueue, stillThere: @escaping () -> Bool = { true }, _ gone: @escaping () -> Void) {
        self.pid = pid
        self.queue = queue
        self.stillThere = stillThere
        self.gone = gone
    }

    public func start() {
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
        source.setEventHandler { [weak self] in self?.fire() }
        self.source = source
        source.activate()
        queue.async { [weak self] in
            guard let self = self else { return }
            // kill(pid, 0) fails with ESRCH for a process that is gone; a
            // zombie, not yet reaped, still counts as there, and kqueue
            // reports its exit.
            if !self.stillThere() || (kill(self.pid, 0) != 0 && errno == ESRCH) {
                self.fire()
            }
        }
    }

    private func fire() {
        guard !fired else { return }
        fired = true
        source?.cancel()
        gone()
    }
}

/// Reads a file descriptor (stdin) on its own thread, so that a blocking
/// read never holds the main queue, and hands each chunk, then EOF, to `queue`
/// in order. A read error counts as EOF: the parent is gone either way.
public final class InputReader {
    private let fd: Int32
    private let queue: DispatchQueue
    private let onData: (Data) -> Void
    private let onEOF: () -> Void

    public init(fd: Int32, queue: DispatchQueue, onData: @escaping (Data) -> Void, onEOF: @escaping () -> Void) {
        self.fd = fd
        self.queue = queue
        self.onData = onData
        self.onEOF = onEOF
    }

    public func start() {
        let thread = Thread { [fd, queue, onData, onEOF] in
            var buf = [UInt8](repeating: 0, count: 16 << 10)
            while true {
                let n = read(fd, &buf, buf.count)
                if n < 0, errno == EINTR { continue }
                if n <= 0 {
                    queue.async { onEOF() }
                    return
                }
                let chunk = Data(buf[0..<n])
                queue.async { onData(chunk) }
            }
        }
        thread.name = "localmost-macvm stdin"
        thread.start()
    }
}
