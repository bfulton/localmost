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
}

final class LoopbackTests: XCTestCase {
    func testConnectsToALoopbackListener() throws {
        let server = try TCPServer()
        defer { server.close() }
        let fd = try connectLoopback(port: server.port)
        Darwin.close(fd)
    }

    func testAPortWithNoListenerFails() throws {
        let server = try TCPServer()
        let port = server.port
        server.close()
        XCTAssertThrowsError(try connectLoopback(port: port))
    }
}

// MARK: - Test sockets

func connectUnix(_ path: String) throws -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        let bytes = Array(path.utf8)
        raw.copyBytes(from: bytes)
        raw[bytes.count] = 0
    }
    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
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

    init() throws {
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
                bind(fd, $0, len) == 0 && listen(fd, 16) == 0 && getsockname(fd, $0, &len) == 0
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
