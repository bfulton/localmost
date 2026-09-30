import XCTest
@testable import localmost_vm

/// The helper's unix sockets and its one TCP dial (contract §2.3).
final class UnixListenerTests: XCTestCase {
    private var tmp: TempDir!

    override func setUpWithError() throws {
        tmp = try TempDir()
    }

    override func tearDown() {
        tmp = nil
    }

    func testTheSocketIsOwnerOnlyAndAcceptsConnections() throws {
        let path = tmp.real + "/docker.sock"
        let accepted = expectation(description: "accepted")
        let listener = try UnixListener(path: path, maxConnections: 4) { conn in
            XCTAssertGreaterThanOrEqual(conn.fd, 0)
            conn.release()
            accepted.fulfill()
        }
        defer { listener.close() }
        let st = try XCTUnwrap(lstatOf(path))
        XCTAssertEqual(st.st_mode & S_IFMT, S_IFSOCK)
        XCTAssertEqual(st.st_mode & 0o777, 0o600)
        let client = try connectUnix(path)
        defer { Darwin.close(client) }
        wait(for: [accepted], timeout: 10)
    }

    func testAnExistingPathIsNotReplaced() throws {
        let path = try tmp.write("docker.sock", 3)
        XCTAssertThrowsError(try UnixListener(path: path, maxConnections: 4) { _ in }) {
            XCTAssertEqual(($0 as? HelperError)?.code, .socket)
        }
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)).count, 3, "the file is left alone")
    }

    func testAPathTooLongForSunPathIsRefused() throws {
        let long = tmp.real + "/" + String(repeating: "d", count: 110) + ".sock"
        XCTAssertThrowsError(try UnixListener(path: long, maxConnections: 4) { _ in }) {
            XCTAssertEqual(($0 as? HelperError)?.code, .socket)
        }
    }

    func testAMissingDirectoryIsASocketError() throws {
        XCTAssertThrowsError(try UnixListener(path: tmp.real + "/gone/docker.sock", maxConnections: 4) { _ in }) {
            XCTAssertEqual(($0 as? HelperError)?.code, .socket)
        }
    }

    func testConnectionsPastTheLimitAreClosedAtOnce() throws {
        let path = tmp.real + "/agent.sock"
        var held: [UnixListener.Connection] = []
        var accepted = 0
        let lock = NSLock()
        let two = expectation(description: "two accepted")
        two.expectedFulfillmentCount = 2
        let listener = try UnixListener(path: path, maxConnections: 2) { conn in
            lock.lock()
            held.append(conn)
            accepted += 1
            let early = accepted <= 2
            lock.unlock()
            if early { two.fulfill() }
        }
        defer { listener.close() }
        let a = try connectUnix(path), b = try connectUnix(path)
        wait(for: [two], timeout: 10)
        let c = try connectUnix(path)
        XCTAssertTrue(waitForEOF(c), "the third connection is closed by the helper")
        XCTAssertEqual(listener.active, 2)

        // Releasing one makes room again.
        lock.lock()
        let first = held.removeFirst()
        lock.unlock()
        first.release()
        let again = expectation(description: "accepted again")
        let d = try connectUnix(path)
        DispatchQueue.global().async {
            while listener.active < 2 { usleep(10000) }
            again.fulfill()
        }
        wait(for: [again], timeout: 10)
        for fd in [a, b, c, d] { Darwin.close(fd) }
        held.forEach { $0.release() }
    }

    func testCloseUnlinksTheSocket() throws {
        let path = tmp.real + "/docker.sock"
        let listener = try UnixListener(path: path, maxConnections: 1) { $0.release() }
        listener.close()
        XCTAssertNil(lstatOf(path))
    }

    func testWhenTheSecondSocketCannotBeBoundTheFirstIsRemoved() throws {
        let docker = tmp.real + "/docker.sock"
        let agent = try tmp.write("agent.sock", 3)
        XCTAssertThrowsError(try bindListeners([(docker, { $0.release() }), (agent, { $0.release() })], maxConnections: 4)) {
            XCTAssertEqual(($0 as? HelperError)?.code, .socket)
        }
        XCTAssertNil(lstatOf(docker), "the socket bound first is closed and removed")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: agent)).count, 3, "the file in the way is left alone")
    }

    func testBothSocketsAreBoundInOrder() throws {
        let docker = tmp.real + "/docker.sock", agent = tmp.real + "/agent.sock"
        let listeners = try bindListeners([(docker, { $0.release() }), (agent, { $0.release() })], maxConnections: 4)
        defer { listeners.forEach { $0.close() } }
        XCTAssertEqual(listeners.map(\.path), [docker, agent])
    }

    /// Out of file descriptors, accept fails with EMFILE, and XNU drops the
    /// connection it could not hand over rather than leave it in the backlog
    /// (where it would wake the listener again at once). So the client sees
    /// its connection closed, the listener does not spin, and once
    /// descriptors are free the next connection is accepted.
    func testRunningOutOfDescriptorsNeitherSpinsNorWedges() throws {
        let path = tmp.real + "/docker.sock"
        let accepted = expectation(description: "accepted once descriptors are free")
        let listener = try UnixListener(path: path, maxConnections: 4) { conn in
            conn.release()
            accepted.fulfill()
        }
        defer { listener.close() }
        // The client's socket is made first: connecting needs no new descriptor.
        let client = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(client, 0)
        defer { Darwin.close(client) }

        var saved = rlimit()
        XCTAssertEqual(getrlimit(RLIMIT_NOFILE, &saved), 0)
        var held: [Int32] = []
        func restore() {
            held.forEach { Darwin.close($0) }
            held.removeAll()
            var r = saved
            setrlimit(RLIMIT_NOFILE, &r)
        }
        defer { restore() }
        let lowest = dup(0)
        XCTAssertGreaterThanOrEqual(lowest, 0)
        held.append(lowest)
        var low = rlimit(rlim_cur: rlim_t(lowest + 16), rlim_max: saved.rlim_max)
        XCTAssertEqual(setrlimit(RLIMIT_NOFILE, &low), 0)
        while true {
            let fd = dup(0)
            if fd < 0 { break }
            held.append(fd)
        }

        let before = listener.wakeups
        XCTAssertEqual(connectTo(client, path), 0)
        XCTAssertTrue(waitForEOF(client), "the connection is closed, not left hanging")
        Thread.sleep(forTimeInterval: 0.5)
        let wakeups = listener.wakeups - before
        restore()
        XCTAssertLessThan(wakeups, 50, "the listener spun on EMFILE")

        let next = try connectUnix(path)
        defer { Darwin.close(next) }
        wait(for: [accepted], timeout: 10)
    }
}

/// The helper raises its own descriptor limit: launchd's default soft limit
/// of 256 is less than its connections can use (§2.3).
final class FileLimitTests: XCTestCase {
    /// RLIM_INFINITY, which Swift does not import.
    private let unlimited = rlim_t(Int64.max)

    func testTheTargetIsTheWantedLimitWithinTheHardLimitAndNeverLower() {
        XCTAssertEqual(fileLimitTarget(current: 256, max: unlimited, wanted: 1024), 1024)
        XCTAssertEqual(fileLimitTarget(current: 256, max: 512, wanted: 1024), 512)
        XCTAssertEqual(fileLimitTarget(current: 4096, max: unlimited, wanted: 1024), 4096)
    }

    func testTheSoftLimitIsRaised() throws {
        var saved = rlimit()
        XCTAssertEqual(getrlimit(RLIMIT_NOFILE, &saved), 0)
        defer {
            var r = saved
            setrlimit(RLIMIT_NOFILE, &r)
        }
        var low = rlimit(rlim_cur: 256, rlim_max: saved.rlim_max)
        XCTAssertEqual(setrlimit(RLIMIT_NOFILE, &low), 0)
        raiseFileLimit()
        var now = rlimit()
        XCTAssertEqual(getrlimit(RLIMIT_NOFILE, &now), 0)
        XCTAssertEqual(now.rlim_cur, min(rlim_t(helperFileLimit), saved.rlim_max))
    }
}

/// The relay's dial to the proxy: never a blocked thread, and never longer
/// than its timeout.
final class LoopbackTests: XCTestCase {
    private let queue = DispatchQueue(label: "test dial")

    private func dial(_ port: Int, timeoutMs: Int = 5000) -> Result<Int32, POSIXError> {
        let done = expectation(description: "dialled")
        var result: Result<Int32, POSIXError>?
        dialLoopback(port: port, queue: queue, timeoutMs: timeoutMs) {
            dispatchPrecondition(condition: .onQueue(self.queue))
            result = $0
            done.fulfill()
        }
        wait(for: [done], timeout: Double(timeoutMs) / 1000 + 5)
        return result ?? .failure(POSIXError(.EIO))
    }

    func testConnectsToALoopbackListener() throws {
        let server = try TCPServer()
        defer { server.close() }
        let fd = try dial(server.port).get()
        defer { Darwin.close(fd) }
        let peer = server.accept()
        defer { Darwin.close(peer) }
        XCTAssertTrue(writeFully(fd, Data("hi".utf8)))
        XCTAssertEqual(readFully(peer, 2), Data("hi".utf8))
    }

    func testAPortWithNoListenerFails() throws {
        let server = try TCPServer()
        let port = server.port
        server.close()
        XCTAssertThrowsError(try dial(port).get())
    }

    func testAProxyThatNeverAcceptsTimesOutWithoutBlockingTheCaller() throws {
        // A listener that never accepts, with its backlog full: the next
        // connect's SYN is dropped, and it would wait for TCP's own timeout.
        let server = try TCPServer(backlog: 1)
        defer { server.close() }
        var clients: [Int32] = []
        defer { clients.forEach { Darwin.close($0) } }
        var pending = false
        for _ in 0..<64 where !pending {
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            clients.append(fd)
            _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")
            addr.sin_port = in_port_t(UInt16(server.port).bigEndian)
            _ = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
            pending = poll(&pfd, 1, 300) == 0
        }
        XCTAssertTrue(pending, "the backlog filled")
        guard pending else { return }

        let started = Date()
        let done = expectation(description: "gave up")
        var result: Result<Int32, POSIXError>?
        dialLoopback(port: server.port, queue: queue, timeoutMs: 500) {
            result = $0
            done.fulfill()
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.2, "the call itself returns at once")
        wait(for: [done], timeout: 10)
        guard case .failure(let error)? = result else {
            return XCTFail("the dial did not fail: \(String(describing: result))")
        }
        XCTAssertEqual(error.code, .ETIMEDOUT)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }
}

// MARK: - Test sockets

/// Connects an existing socket to a unix path; connect(2)'s result.
func connectTo(_ fd: Int32, _ path: String) -> Int32 {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        let bytes = Array(path.utf8)
        raw.copyBytes(from: bytes)
        raw[bytes.count] = 0
    }
    return withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
}

func connectUnix(_ path: String) throws -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    let rc = connectTo(fd, path)
    guard rc == 0 else {
        let e = errno
        Darwin.close(fd)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(e))
    }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    return fd
}

/// Whether the peer closes within a few seconds (a read returns 0 or fails).
func waitForEOF(_ fd: Int32, seconds: Int32 = 5) -> Bool {
    var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    guard poll(&pfd, 1, seconds * 1000) == 1 else { return false }
    var b: UInt8 = 0
    return read(fd, &b, 1) <= 0
}

/// Reads exactly `count` bytes, or fewer at EOF.
func readFully(_ fd: Int32, _ count: Int) -> Data {
    var out = Data()
    var buf = [UInt8](repeating: 0, count: 64 << 10)
    while out.count < count {
        let n = read(fd, &buf, min(buf.count, count - out.count))
        if n < 0, errno == EINTR { continue }
        if n <= 0 { break }
        out.append(buf, count: n)
    }
    return out
}

func writeFully(_ fd: Int32, _ data: Data) -> Bool {
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

/// A TCP listener on 127.0.0.1 with an ephemeral port.
final class TCPServer {
    let fd: Int32
    let port: Int

    init(backlog: Int32 = 16) throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        self.fd = fd
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let ok = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, len) == 0 && listen(fd, backlog) == 0 && getsockname(fd, $0, &len) == 0
            }
        }
        guard ok else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        port = Int(UInt16(bigEndian: addr.sin_port))
    }

    func accept() -> Int32 {
        Darwin.accept(fd, nil, nil)
    }

    func close() {
        Darwin.close(fd)
    }
}
