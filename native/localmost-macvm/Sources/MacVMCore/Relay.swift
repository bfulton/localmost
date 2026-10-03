// Copies bytes both ways between two sockets, never looking at them: the
// helper's unix and vsock connections, and the guest agent's loopback and
// vsock ones. Copied from native/localmost-vm (its contract §2.3) rather than
// shared, so that neither helper's review depends on the other's package.
// Each relay runs on its own serial queue with non-blocking fds and dispatch
// sources, so that nothing blocks a thread, least of all VZ's queue. Each
// direction buffers at most 1 MiB: when the reader outruns the writer,
// reading stops until the writer catches up, and the sender sees
// backpressure. A half-close (EOF one way) is passed on with shutdown.

import Foundation

public final class Relay {
    /// One side: its fd, and how to close it once the relay is done with it.
    public struct End {
        public let fd: Int32
        public let close: () -> Void

        public init(fd: Int32, close: @escaping () -> Void) {
            self.fd = fd
            self.close = close
        }
    }

    /// The most bytes one direction holds (§2.3).
    static let bufferLimit = 1 << 20
    private static let chunkSize = 64 << 10

    private final class Direction {
        let src: Int32
        let dst: Int32
        let readSource: DispatchSourceRead
        let writeSource: DispatchSourceWrite
        var chunks: [Data] = []
        /// Bytes of chunks[0] already written.
        var offset = 0
        var buffered = 0
        var readSuspended = false
        var writeSuspended = false
        /// The source reached EOF.
        var eof = false
        /// The EOF was passed on to the destination.
        var done = false

        init(src: Int32, dst: Int32, queue: DispatchQueue) {
            self.src = src
            self.dst = dst
            readSource = DispatchSource.makeReadSource(fileDescriptor: src, queue: queue)
            writeSource = DispatchSource.makeWriteSource(fileDescriptor: dst, queue: queue)
        }
    }

    private let a: End
    private let b: End
    private let queue: DispatchQueue
    private var forward: Direction!
    private var backward: Direction!
    private var finished = false
    private var cancelled: [Int32: Int] = [:]
    private var closedEnds = 0
    private var peak = 0

    /// Called once, on the relay's queue, after both ends are closed.
    public var onFinish: (() -> Void)?

    /// The most either direction held at once, for tests.
    public var peakBuffered: Int { queue.sync { peak } }

    public init(_ a: End, _ b: End, label: String) {
        self.a = a
        self.b = b
        queue = DispatchQueue(label: "localmost-macvm relay \(label)")
    }

    public func start() {
        queue.async { self.setUp() }
    }

    /// Ends the relay and closes both sides.
    public func cancel() {
        queue.async { self.teardown() }
    }

    private func setUp() {
        for fd in [a.fd, b.fd] {
            _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
            noSigPipe(fd)
        }
        forward = Direction(src: a.fd, dst: b.fd, queue: queue)
        backward = Direction(src: b.fd, dst: a.fd, queue: queue)
        // The handlers hold the relay strongly, so it lives until teardown
        // cancels its sources, whoever else lets go of it.
        for d in [forward!, backward!] {
            d.readSource.setEventHandler { self.readable(d) }
            d.writeSource.setEventHandler { self.writable(d) }
            d.readSource.setCancelHandler { self.sourceCancelled(d.src) }
            d.writeSource.setCancelHandler { self.sourceCancelled(d.dst) }
            d.readSource.activate()
            d.writeSource.activate()
            // Nothing to write yet.
            d.writeSource.suspend()
            d.writeSuspended = true
        }
    }

    private func readable(_ d: Direction) {
        guard !finished, !d.eof else { return }
        let room = Relay.bufferLimit - d.buffered
        guard room > 0 else { return suspendRead(d) }
        var chunk = Data(count: min(Relay.chunkSize, room))
        let n = chunk.withUnsafeMutableBytes { read(d.src, $0.baseAddress, $0.count) }
        if n > 0 {
            chunk.count = n
            d.chunks.append(chunk)
            d.buffered += n
            peak = max(peak, d.buffered)
            resumeWrite(d)
            if d.buffered >= Relay.bufferLimit { suspendRead(d) }
        } else if n == 0 {
            d.eof = true
            suspendRead(d)
            if d.buffered == 0 { passEOF(d) }
        } else if errno != EAGAIN && errno != EINTR {
            teardown()
        }
    }

    private func writable(_ d: Direction) {
        guard !finished else { return }
        while let head = d.chunks.first {
            let n = head.withUnsafeBytes { write(d.dst, $0.baseAddress! + d.offset, $0.count - d.offset) }
            if n > 0 {
                d.offset += n
                d.buffered -= n
                if d.offset == head.count {
                    d.chunks.removeFirst()
                    d.offset = 0
                }
            } else if n < 0 && (errno == EAGAIN || errno == EINTR) {
                break
            } else {
                return teardown()
            }
        }
        if d.chunks.isEmpty {
            suspendWrite(d)
            if d.eof { return passEOF(d) }
        }
        if !d.eof && d.buffered < Relay.bufferLimit { resumeRead(d) }
    }

    private func passEOF(_ d: Direction) {
        guard !d.done else { return }
        d.done = true
        _ = shutdown(d.dst, SHUT_WR)
        if forward.done && backward.done { teardown() }
    }

    private func suspendRead(_ d: Direction) {
        guard !d.readSuspended else { return }
        d.readSuspended = true
        d.readSource.suspend()
    }

    private func resumeRead(_ d: Direction) {
        guard d.readSuspended else { return }
        d.readSuspended = false
        d.readSource.resume()
    }

    private func suspendWrite(_ d: Direction) {
        guard !d.writeSuspended else { return }
        d.writeSuspended = true
        d.writeSource.suspend()
    }

    private func resumeWrite(_ d: Direction) {
        guard d.writeSuspended else { return }
        d.writeSuspended = false
        d.writeSource.resume()
    }

    private func teardown() {
        guard !finished else { return }
        finished = true
        guard let forward = forward, let backward = backward else {
            // Cancelled before it started: nothing was set up on the fds.
            a.close()
            b.close()
            onFinish?()
            return
        }
        for d in [forward, backward] {
            // A suspended source runs its cancel handler only once resumed.
            resumeRead(d)
            resumeWrite(d)
            d.readSource.cancel()
            d.writeSource.cancel()
            d.chunks.removeAll()
        }
    }

    /// Each fd has two sources; once both are cancelled, nothing touches it
    /// again and it is closed.
    private func sourceCancelled(_ fd: Int32) {
        cancelled[fd, default: 0] += 1
        guard cancelled[fd] == 2 else { return }
        (fd == a.fd ? a : b).close()
        closedEnds += 1
        if closedEnds == 2 {
            onFinish?()
            onFinish = nil
        }
    }
}
