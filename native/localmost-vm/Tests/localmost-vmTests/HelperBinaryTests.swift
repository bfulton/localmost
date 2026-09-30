import XCTest
@testable import localmost_vm

/// The built helper, run as Electron runs it: its exit codes, its last
/// event, and its pid file, for each failure it can meet before VZ is asked
/// to do anything. (Starting a VM needs the entitlement and a guest, and runs
/// in the acceptance stage on the Mac.)
final class HelperBinaryTests: XCTestCase {
    private var tmp: TempDir!
    private let vmId = "3-0123456789ab"
    private let sid = "3-a1b2c3d4e5f6"

    private var binary: String {
        Bundle(for: HelperBinaryTests.self).bundleURL.deletingLastPathComponent().appendingPathComponent("localmost-vm").path
    }

    override func setUpWithError() throws {
        tmp = try TempDir()
        try tmp.mkdir("data/vm/jobs/\(vmId)")
        try tmp.write("data/vm/jobs/\(vmId)/data.img", 1 << 20)
        try tmp.mkdir("data/runner/sandbox/\(sid)/_work")
        try tmp.write("res/guest/vmlinux", 100)
        try tmp.write("res/guest/initramfs.cpio.gz", 10)
        try tmp.write("res/guest/rootfs.erofs", 4096)
        let manifest: [String: Any] = ["schema": 1, "artifacts": [
            "vmlinux": ["size": 100], "initramfs.cpio.gz": ["size": 10], "rootfs.erofs": ["size": 4096],
        ]]
        try tmp.write("res/guest/manifest.json", try JSONSerialization.data(withJSONObject: manifest))
    }

    override func tearDown() {
        tmp = nil
    }

    private var jobArgs: [String] {
        ["run", "--vm-id", vmId, "--mode", "job", "--data-dir", tmp.sub("data"), "--resources", tmp.sub("res"),
         "--sandbox-id", sid, "--proxy-port", "3128", "--cpus", "1", "--memory-mib", "1024", "--rosetta", "off"]
    }

    private struct Result {
        var status: Int32
        var stdout: [[String: Any]]
        var stderr: String
        var pid: Int32
    }

    private func helper(_ args: [String]) throws -> Result {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: binary)
        p.arguments = args
        p.environment = ["PATH": "/usr/bin:/bin", "TMPDIR": tmp.real]
        let input = Pipe(), out = Pipe(), err = Pipe()
        p.standardInput = input
        p.standardOutput = out
        p.standardError = err
        try p.run()
        let o = out.fileHandleForReading.readDataToEndOfFile()
        let e = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        try? input.fileHandleForWriting.close()
        let lines = o.split(separator: UInt8(ascii: "\n")).map { try! JSONSerialization.jsonObject(with: Data($0)) as! [String: Any] }
        return Result(status: p.terminationStatus, stdout: lines, stderr: String(decoding: e, as: UTF8.self), pid: p.processIdentifier)
    }

    private func assertFails(_ args: [String], _ code: ErrorCode, file: StaticString = #filePath, line: UInt = #line) throws {
        let r = try helper(args)
        XCTAssertEqual(r.status, code.exitCode, r.stderr, file: file, line: line)
        XCTAssertEqual(r.stdout.last?["event"] as? String, "stopped", file: file, line: line)
        XCTAssertEqual(r.stdout.last?["reason"] as? String, "error", file: file, line: line)
        XCTAssertEqual(r.stdout.last?["code"] as? String, code.rawValue, file: file, line: line)
        XCTAssertEqual(r.stdout.last?["v"] as? Int, 1, file: file, line: line)
        XCTAssertTrue(r.stderr.hasPrefix("error "), r.stderr, file: file, line: line)
    }

    func testVersionPrintsTheHelperAndContractVersions() throws {
        let r = try helper(["version"])
        XCTAssertEqual(r.status, 0)
        XCTAssertEqual(r.stdout.count, 1)
        XCTAssertEqual(r.stdout[0]["contract"] as? Int, 1)
        let version = try XCTUnwrap(r.stdout[0]["helper"] as? String)
        XCTAssertNotNil(version.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+$"#, options: .regularExpression), version)
        XCTAssertEqual(Set(r.stdout[0].keys), ["helper", "contract"])
    }

    func testBadArgumentsExit64() throws {
        try assertFails(["run"], .args)
        try assertFails(jobArgs + ["--kernel", "/tmp/k"], .args)
        let r = try helper(["start"])
        XCTAssertEqual(r.status, 64)
        XCTAssertTrue(r.stdout.isEmpty, "only run speaks the control protocol")
    }

    func testAMissingVmDirectoryExits64() throws {
        try FileManager.default.removeItem(atPath: tmp.sub("data/vm/jobs/\(vmId)"))
        try assertFails(jobArgs, .args)
    }

    func testAWrongSizedGuestExits66() throws {
        try tmp.write("res/guest/rootfs.erofs", 4095)
        try assertFails(jobArgs, .guestImage)
    }

    func testAMissingDataDiskExits67() throws {
        try FileManager.default.removeItem(atPath: tmp.sub("data/vm/jobs/\(vmId)/data.img"))
        try assertFails(jobArgs, .disk)
    }

    func testALinkedShareExits65() throws {
        try FileManager.default.removeItem(atPath: tmp.sub("data/runner/sandbox/\(sid)/_work"))
        try tmp.symlink("data/runner/sandbox/\(sid)/_work", to: NSHomeDirectory())
        try assertFails(jobArgs, .share)
    }

    func testTheHelperWritesItsPidFirst() throws {
        try FileManager.default.removeItem(atPath: tmp.sub("data/runner/sandbox/\(sid)/_work"))
        let r = try helper(jobArgs)
        XCTAssertEqual(r.status, 65)
        let pid = try String(contentsOfFile: tmp.sub("data/vm/jobs/\(vmId)/helper.pid"), encoding: .utf8)
        XCTAssertEqual(pid, "\(r.pid)\n", "the sweep finds the helper by this pid")
        XCTAssertEqual(try XCTUnwrap(lstatOf(tmp.sub("data/vm/jobs/\(vmId)/helper.pid"))).st_mode & 0o777, 0o600)
    }

    func testARefreshWithoutItsDiskExits67() throws {
        try tmp.mkdir("data/vm/jobs/0-0123456789ab")
        try tmp.mkdir("data/vm/cache/0123456789abcdef")
        try assertFails(["run", "--vm-id", "0-0123456789ab", "--mode", "refresh", "--data-dir", tmp.sub("data"), "--resources",
                         tmp.sub("res"), "--repo-key", "0123456789abcdef", "--cpus", "1", "--memory-mib", "1024", "--rosetta", "off"], .disk)
    }
}
