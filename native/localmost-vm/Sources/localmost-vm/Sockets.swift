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
        while true {
            let conn = accept(fd, nil, nil)
            if conn < 0 {
                if errno == EINTR { continue }
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

/// Dials 127.0.0.1:<port>, the worker's proxy. This is the helper's only TCP
/// connection; its seatbelt profile allows no other.
func connectLoopback(port: Int) throws -> Int32 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    noSigPipe(fd)
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = in_addr_t(UInt32(0x7f00_0001).bigEndian)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard rc == 0 else {
        let e = errno
        Darwin.close(fd)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(e))
    }
    return fd
}

/// Writes to a closed peer fail with EPIPE instead of raising SIGPIPE.
func noSigPipe(_ fd: Int32) {
    var on: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
}

func posixMessage() -> String {
    String(cString: strerror(errno))
}
