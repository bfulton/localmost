import XCTest
@testable import localmost_vm

/// Byte copying between two sockets (contract §2.3): both ways, with a
/// bounded buffer per direction, half-close passed on, and each end closed
/// exactly once.
final class RelayTests: XCTestCase {
    /// Two socket pairs with a relay between their inner ends; the test holds the outer ends.
    private final class Rig {
        var left: [Int32] = [0, 0]
        var right: [Int32] = [0, 0]
        var closedLeft = 0
        var closedRight = 0
        var finished: XCTestExpectation?
        var relay: Relay!
        let lock = NSLock()

        init(_ test: XCTestCase) {
            XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &left), 0)
            XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &right), 0)
            for fd in left + right {
                var on: Int32 = 1
                setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            }
            let l = left[1], r = right[1]
            relay = Relay(
                Relay.End(fd: l) { [self] in self.lock.lock(); self.closedLeft += 1; self.lock.unlock(); Darwin.close(l) },
                Relay.End(fd: r) { [self] in self.lock.lock(); self.closedRight += 1; self.lock.unlock(); Darwin.close(r) },
                label: "test"
            )
            relay.onFinish = { [self] in self.finished?.fulfill() }
        }

        var outerLeft: Int32 { left[0] }
        var outerRight: Int32 { right[0] }
    }

    func testBytesFlowBothWays() {
        let rig = Rig(self)
        rig.relay.start()
        XCTAssertTrue(writeFully(rig.outerLeft, Data("GET /_ping HTTP/1.1\r\n\r\n".utf8)))
        XCTAssertEqual(readFully(rig.outerRight, 23), Data("GET /_ping HTTP/1.1\r\n\r\n".utf8))
        XCTAssertTrue(writeFully(rig.outerRight, Data("HTTP/1.1 200 OK\r\n\r\nOK".utf8)))
        XCTAssertEqual(readFully(rig.outerLeft, 21), Data("HTTP/1.1 200 OK\r\n\r\nOK".utf8))
        close(rig.outerLeft)
        close(rig.outerRight)
    }

    func testALargeTransferToASlowReaderArrivesIntactWithinTheBufferBound() {
        let rig = Rig(self)
        rig.relay.start()
        var payload = Data(count: 8 << 20)
        payload.withUnsafeMutableBytes { arc4random_buf($0.baseAddress!, $0.count) }
        DispatchQueue.global().async {
            XCTAssertTrue(writeFully(rig.outerLeft, payload))
        }
        var got = Data()
        while got.count < payload.count {
            usleep(2000)
            let chunk = readFully(rig.outerRight, min(256 << 10, payload.count - got.count))
            if chunk.isEmpty { break }
            got.append(chunk)
        }
        XCTAssertEqual(got.count, payload.count)
        XCTAssertTrue(got == payload, "the bytes arrive unchanged and in order")
        XCTAssertLessThanOrEqual(rig.relay.peakBuffered, Relay.bufferLimit)
        XCTAssertGreaterThan(rig.relay.peakBuffered, 0)
        close(rig.outerLeft)
        close(rig.outerRight)
    }

    func testHalfCloseIsPassedOnAndTheOtherWayKeepsWorking() {
        let rig = Rig(self)
        rig.finished = expectation(description: "finished")
        rig.relay.start()
        XCTAssertTrue(writeFully(rig.outerLeft, Data("request".utf8)))
        shutdown(rig.outerLeft, SHUT_WR)
        XCTAssertEqual(readFully(rig.outerRight, 100), Data("request".utf8), "the data, then EOF")
        XCTAssertTrue(writeFully(rig.outerRight, Data("response".utf8)))
        XCTAssertEqual(readFully(rig.outerLeft, 8), Data("response".utf8))
        shutdown(rig.outerRight, SHUT_WR)
        wait(for: [rig.finished!], timeout: 10)
        XCTAssertTrue(waitForEOF(rig.outerLeft))
        rig.lock.lock()
        XCTAssertEqual(rig.closedLeft, 1)
        XCTAssertEqual(rig.closedRight, 1)
        rig.lock.unlock()
        close(rig.outerLeft)
        close(rig.outerRight)
    }

    func testAPeerThatGoesAwayClosesBothEndsOnce() {
        let rig = Rig(self)
        rig.finished = expectation(description: "finished")
        rig.relay.start()
        close(rig.outerLeft)
        // The right side still talks; the relay finds the left gone and ends.
        _ = writeFully(rig.outerRight, Data(repeating: 1, count: 4096))
        shutdown(rig.outerRight, SHUT_WR)
        wait(for: [rig.finished!], timeout: 10)
        XCTAssertTrue(waitForEOF(rig.outerRight))
        rig.lock.lock()
        XCTAssertEqual(rig.closedLeft, 1)
        XCTAssertEqual(rig.closedRight, 1)
        rig.lock.unlock()
        close(rig.outerRight)
    }

    func testCancelClosesBothEnds() {
        let rig = Rig(self)
        rig.finished = expectation(description: "finished")
        rig.relay.start()
        rig.relay.cancel()
        wait(for: [rig.finished!], timeout: 10)
        XCTAssertTrue(waitForEOF(rig.outerLeft))
        XCTAssertTrue(waitForEOF(rig.outerRight))
        close(rig.outerLeft)
        close(rig.outerRight)
    }

    func testTheBufferIsOneMebibytePerDirection() {
        XCTAssertEqual(Relay.bufferLimit, 1 << 20)
    }
}

/// The console log (contract §2.2): cut to its last 1 MiB when it passes 2 MiB.
final class ConsoleLogTests: XCTestCase {
    func testTheLimitsAreTheContracts() {
        XCTAssertEqual(ConsoleLog.defaultLimit, 2 << 20)
        XCTAssertEqual(ConsoleLog.defaultKeep, 1 << 20)
    }

    func testTheLogIsCutToItsTailWhenItPassesTheLimit() throws {
        let tmp = try TempDir()
        let path = tmp.real + "/console.log"
        let log = try ConsoleLog(path: path, limit: 2000, keep: 1000)
        var all = Data()
        for i in 0..<50 {
            let chunk = Data("line \(i) \(String(repeating: "x", count: 90))\n".utf8)
            all.append(chunk)
            log.append(chunk)
            let size = try XCTUnwrap(lstatOf(path)).st_size
            XCTAssertLessThanOrEqual(Int(size), 2000)
        }
        let file = try Data(contentsOf: URL(fileURLWithPath: path))
        XCTAssertTrue(all.suffix(file.count) == file, "the file is the tail of what was written")
        XCTAssertGreaterThanOrEqual(file.count, 1000)
    }

    func testTheLogIsOwnerOnly() throws {
        let tmp = try TempDir()
        let path = tmp.real + "/console.log"
        _ = try ConsoleLog(path: path)
        XCTAssertEqual(try XCTUnwrap(lstatOf(path)).st_mode & 0o777, 0o600)
    }

    func testALinkAtThePathIsRefused() throws {
        let tmp = try TempDir()
        let target = try tmp.write("target", 1)
        try tmp.symlink("console.log", to: target)
        XCTAssertThrowsError(try ConsoleLog(path: tmp.real + "/console.log"))
    }
}
