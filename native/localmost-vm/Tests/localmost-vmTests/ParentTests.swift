import XCTest
@testable import localmost_vm

/// Parent death (contract §2.4): the exit of the recorded parent, or EOF on
/// stdin, stops the VM with no grace. This is what stops every VM when
/// Electron main crashes or is killed.
final class ParentTests: XCTestCase {
    /// A child process standing in for the parent.
    private func child() throws -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sleep")
        p.arguments = ["60"]
        try p.run()
        return p
    }

    func testTheExitOfTheWatchedProcessIsSeen() throws {
        let parent = try child()
        let gone = expectation(description: "exit seen")
        let watch = ParentWatch(pid: parent.processIdentifier, queue: .main) { gone.fulfill() }
        watch.start()
        parent.terminate()
        wait(for: [gone], timeout: 10)
        withExtendedLifetime(watch) {}
    }

    func testAKilledParentIsSeen() throws {
        let parent = try child()
        let gone = expectation(description: "exit seen")
        let watch = ParentWatch(pid: parent.processIdentifier, queue: .main) { gone.fulfill() }
        watch.start()
        kill(parent.processIdentifier, SIGKILL)
        wait(for: [gone], timeout: 10)
        withExtendedLifetime(watch) {}
    }

    func testAParentThatIsAlreadyGoneIsSeenAtOnce() throws {
        let parent = try child()
        parent.terminate()
        parent.waitUntilExit()
        let gone = expectation(description: "exit seen")
        let watch = ParentWatch(pid: parent.processIdentifier, queue: .main, stillThere: { false }) { gone.fulfill() }
        watch.start()
        wait(for: [gone], timeout: 10)
        withExtendedLifetime(watch) {}
    }

    func testTheWatchFiresOnce() throws {
        let parent = try child()
        let gone = expectation(description: "exit seen")
        gone.assertForOverFulfill = true
        let watch = ParentWatch(pid: parent.processIdentifier, queue: .main, stillThere: { false }) { gone.fulfill() }
        watch.start()
        parent.terminate()
        wait(for: [gone], timeout: 10)
        let settle = expectation(description: "settle")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { settle.fulfill() }
        wait(for: [settle], timeout: 5)
        withExtendedLifetime(watch) {}
    }

    func testALiveParentIsNotReported() throws {
        let parent = try child()
        defer { parent.terminate() }
        let gone = expectation(description: "exit seen")
        gone.isInverted = true
        let watch = ParentWatch(pid: parent.processIdentifier, queue: .main) { gone.fulfill() }
        watch.start()
        wait(for: [gone], timeout: 0.5)
        withExtendedLifetime(watch) {}
    }

    func testAnOrphanRefusesToRun() {
        XCTAssertThrowsError(try checkParent(1)) { XCTAssertEqual(($0 as? HelperError)?.code, .args) }
        XCTAssertNoThrow(try checkParent(getpid()))
    }

    // MARK: - stdin

    func testEofOnInputIsSeenAfterEveryLine() throws {
        var fds: [Int32] = [0, 0]
        XCTAssertEqual(pipe(&fds), 0)
        var got = Data()
        let eof = expectation(description: "EOF")
        let reader = InputReader(fd: fds[0], queue: .main, onData: { got.append($0) }, onEOF: { eof.fulfill() })
        reader.start()
        let bytes = Array("{\"v\":1}\n{\"v\":1}\n".utf8)
        XCTAssertEqual(write(fds[1], bytes, bytes.count), bytes.count)
        close(fds[1])
        wait(for: [eof], timeout: 10)
        XCTAssertEqual(got, Data(bytes), "every byte arrives before the EOF")
    }

    // MARK: - Both lead to the stop path

    func testTheParentsExitStopsTheVm() throws {
        let machine = FakeMachine()
        var events: [String] = []
        var code: Int32?
        let c = Controller(mode: .job(sandboxId: "3-a1b2c3d4e5f6", proxyPort: 1), rosetta: "off", machine: machine, hooks: ControllerHooks(
            emit: { events.append((try! JSONSerialization.jsonObject(with: $0) as! [String: Any])["event"] as? String ?? "") },
            log: { _, _ in }, startMs: { 0 }, syncDisk: {}, after: { _, _ in }, finish: { code = $0 }))
        c.begin(dockerSocket: "/d", agentSocket: "/a", preStart: {})
        machine.completeStart(nil)

        let parent = try child()
        let forced = expectation(description: "forced")
        let watch = ParentWatch(pid: parent.processIdentifier, queue: .main) {
            c.parentGone()
            forced.fulfill()
        }
        watch.start()
        kill(parent.processIdentifier, SIGKILL)
        wait(for: [forced], timeout: 10)
        XCTAssertEqual(machine.forces, 1)
        machine.completeForce(nil)
        XCTAssertEqual(events, ["listening", "started", "stopped"])
        XCTAssertEqual(code, 0)
        withExtendedLifetime(watch) {}
    }
}
