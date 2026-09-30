// The helper's sockets (contract §2.3): the two unix sockets it serves in the
// VM's own directory, and the one TCP address it dials, 127.0.0.1:<proxy-port>.
// It listens on nothing else and dials nothing else.

import Foundation

/// The most connections one unix socket holds at a time (§2.3).
let maxConnectionsPerSocket = 64

/// A unix socket, mode 0600, that hands each accepted connection to a
/// handler, up to a limit. A connection past the limit is closed at once.
final class UnixListener {
    /// An accepted connection. It owns its fd until `release()`, which closes
    /// it and frees its place under the limit.
    final class Connection {
        let fd: Int32
        private let lock = NSLock()
        private var released = false
        private let onRelease: () -> Void

        fileprivate init(fd: Int32, onRelease: @escaping () -> Void) {
            self.fd = fd
            self.onRelease = onRelease
        }

        func release() {
            lock.lock()
            let first = !released
            released = true
            lock.unlock()
            guard first else { return }
            Darwin.close(fd)
            onRelease()
        }
    }

    let path: String
    private let fd: Int32
    private let maxConnections: Int
    private let onAccept: (Connection) -> Void
    private let queue: DispatchQueue
    private var source: DispatchSourceRead?
    private let lock = NSLock()
    private var count = 0
    private var closed = false
    private var wakeCount = 0

    /// How many times the listener has woken to accept, for tests.
    var wakeups: Int {
        lock.lock()
        defer { lock.unlock() }
        return wakeCount
    }

    var active: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    /// Binds `path`, which must not exist: an existing file is never
    /// replaced, since the VM's directory is new for every VM.
    init(path: String, maxConnections: Int, _ onAccept: @escaping (Connection) -> Void) throws {
        self.path = path
        self.maxConnections = maxConnections
        self.onAccept = onAccept
        queue = DispatchQueue(label: "localmost-vm accept \((path as NSString).lastPathComponent)")

        var addr = sockaddr_un()
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            throw HelperError(.socket, "\(path) is too long for a unix socket")
        }
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }

        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw HelperError(.socket, "socket for \(path): \(posixMessage())")
        }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        // Owner-only from the moment it exists: bind creates the node through
        // the umask, before any chmod could run.
        let oldMask = umask(0o177)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        let bindErrno = errno
        umask(oldMask)
        guard bound == 0 else {
            Darwin.close(fd)
            throw HelperError(.socket, "bind \(path): \(String(cString: strerror(bindErrno)))")
        }
        guard chmod(path, 0o600) == 0, listen(fd, 64) == 0 else {
            let message = posixMessage()
            Darwin.close(fd)
            unlink(path)
            throw HelperError(.socket, "listen \(path): \(message)")
        }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)

        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptAll() }
        source.setCancelHandler { [fd] in Darwin.close(fd) }
        self.source = source
        source.activate()
    }

    private func acceptAll() {
        lock.lock()
        wakeCount += 1
        lock.unlock()
        while true {
            let conn = accept(fd, nil, nil)
            if conn < 0 {
                if errno == EINTR { continue }
                // EAGAIN: none left. EMFILE or ENFILE: XNU has already
                // dropped the connection it could not hand over, so nothing
                // is left in the backlog to wake this again.
                return
            }
            _ = fcntl(conn, F_SETFD, FD_CLOEXEC)
            // Accepted sockets inherit O_NONBLOCK; the relay sets it itself.
            _ = fcntl(conn, F_SETFL, fcntl(conn, F_GETFL) & ~O_NONBLOCK)
            noSigPipe(conn)
            lock.lock()
            guard !closed, count < maxConnections else {
                lock.unlock()
                Darwin.close(conn)
                continue
            }
            count += 1
            lock.unlock()
            onAccept(Connection(fd: conn) { [weak self] in
                guard let self = self else { return }
                self.lock.lock()
                self.count -= 1
                self.lock.unlock()
            })
        }
    }

    /// Stops accepting and removes the socket. Open connections are left to their owners.
    func close() {
        lock.lock()
        let first = !closed
        closed = true
        lock.unlock()
        guard first else { return }
        source?.cancel()
        unlink(path)
    }
}

/// Binds each socket in order. If one cannot be bound, those already bound
/// are closed and removed before the error is thrown.
func bindListeners(_ sockets: [(path: String, onAccept: (UnixListener.Connection) -> Void)],
                   maxConnections: Int) throws -> [UnixListener] {
    var bound: [UnixListener] = []
    do {
        for socket in sockets {
            bound.append(try UnixListener(path: socket.path, maxConnections: maxConnections, socket.onAccept))
        }
    } catch {
        bound.forEach { $0.close() }
        throw error
    }
    return bound
}

/// The descriptor limit the helper wants. Its sockets alone may hold about
/// 770 descriptors at the §2.3 limits (two sockets of 64 connections, two
/// descriptors each, and 256 relays of two), and launchd's default soft
/// limit is 256.
let helperFileLimit = 1024

/// The soft limit to set: `wanted`, within the hard limit, and never lower
/// than it is.
func fileLimitTarget(current: rlim_t, max: rlim_t, wanted: rlim_t) -> rlim_t {
    guard current < wanted else { return current }
    return Swift.min(wanted, max)
}

/// Raises the soft RLIMIT_NOFILE to `helperFileLimit`, or to the hard limit
/// when that is lower. A failure leaves the limit as it was; a connection
/// that finds none left is closed at once, as one past the §2.3 limits is.
func raiseFileLimit() {
    var limit = rlimit()
    guard getrlimit(RLIMIT_NOFILE, &limit) == 0 else { return }
    let target = fileLimitTarget(current: limit.rlim_cur, max: limit.rlim_max, wanted: rlim_t(helperFileLimit))
    guard target != limit.rlim_cur else { return }
    limit.rlim_cur = target
    _ = setrlimit(RLIMIT_NOFILE, &limit)
}

/// Dials 127.0.0.1:<port>, the worker's proxy. This is the helper's only TCP
/// connection; its seatbelt profile allows no other.
///
/// The connect is non-blocking and finished by a write source on `queue`,
/// so no thread waits on it: a proxy whose backlog is full would otherwise
/// hold a thread for each of up to 256 relays until TCP gave up. After
/// `timeoutMs` it is abandoned with ETIMEDOUT. `done` runs once, on `queue`,
/// and owns the connected fd.
func dialLoopback(port: Int, queue: DispatchQueue, timeoutMs: Int, _ done: @escaping (Result<Int32, POSIXError>) -> Void) {
    func fail(_ code: Int32) {
        let error = POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
        queue.async { done(.failure(error)) }
    }
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return fail(errno) }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    noSigPipe(fd)
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = in_addr_t(UInt32(0x7f00_0001).bigEndian)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    if rc == 0 {
        return queue.async { done(.success(fd)) }
    }
    guard errno == EINPROGRESS else {
        let e = errno
        Darwin.close(fd)
        return fail(e)
    }

    // The outcome is settled once, on `queue`; the fd is closed or handed
    // over only after the source watching it has been cancelled.
    var outcome: Int32?
    let source = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
    func settle(_ code: Int32) {
        guard outcome == nil else { return }
        outcome = code
        source.cancel()
    }
    source.setEventHandler {
        var err: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        if getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) != 0 { err = errno }
        settle(err)
    }
    source.setCancelHandler {
        let code = outcome ?? ECANCELED
        if code == 0 {
            done(.success(fd))
        } else {
            Darwin.close(fd)
            done(.failure(POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)))
        }
    }
    source.activate()
    queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { settle(ETIMEDOUT) }
}

/// Writes to a closed peer fail with EPIPE instead of raising SIGPIPE.
func noSigPipe(_ fd: Int32) {
    var on: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
}

func posixMessage() -> String {
    String(cString: strerror(errno))
}
