import XCTest
@testable import MacVMCore

/// The built helper and agent, run as Electron and the bootstrap run them:
/// exit codes and last events for each refusal that comes before VZ is asked
/// to do anything. (Booting macOS needs the entitlement and a golden image;
/// docs/roadmap/macos-vm-jobs.md says how that is checked on the Mac.)
final class BinaryTests: XCTestCase {
    private var tmp: TempDir!

    private func built(_ name: String) -> String {
        Bundle(for: BinaryTests.self).bundleURL.deletingLastPathComponent().appendingPathComponent(name).path
    }

    override func setUpWithError() throws {
        tmp = try TempDir()
    }

    override func tearDown() {
        tmp = nil
    }

    private struct Ran {
        var status: Int32
        var events: [[String: Any]]
        var stdout: String
        var stderr: String
    }

    private func run(_ binary: String, _ args: [String]) throws -> Ran {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: built(binary))
        p.arguments = args
        p.environment = ["PATH": "/usr/bin:/bin", "TMPDIR": tmp.real]
        let input = Pipe(), out = Pipe(), err = Pipe()
        p.standardInput = input
        p.standardOutput = out
        p.standardError = err
        try p.run()
        try? input.fileHandleForWriting.close()
        let o = out.fileHandleForReading.readDataToEndOfFile()
        let e = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let lines = o.split(separator: UInt8(ascii: "\n")).compactMap { decodeLine(Data($0)) }
        return Ran(status: p.terminationStatus, events: lines, stdout: String(decoding: o, as: UTF8.self),
                   stderr: String(decoding: e, as: UTF8.self))
    }

    func testVersionSaysWhatWasBuiltIn() throws {
        let r = try run("localmost-macvm", ["version"])
        XCTAssertEqual(r.status, 0)
        let o = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(r.stdout.utf8)) as? [String: Any])
        XCTAssertEqual(o["contract"] as? Int, 1)
        XCTAssertEqual(o["agent"] as? String, agentVersion)
        XCTAssertNotNil(o["provisioning"] as? Bool)
    }

    func testABadCommandLineEndsWithEArgs() throws {
        let r = try run("localmost-macvm", ["run", "--vm-id", "3-0123456789ab"])
        XCTAssertEqual(r.status, 64)
        XCTAssertEqual(r.events.last?["event"] as? String, "end")
        XCTAssertEqual(r.events.last?["code"] as? String, "E_ARGS")
        XCTAssertTrue(r.stderr.hasPrefix("error "))
    }

    func testAJobVMWithoutItsDirectoryIsRefused() throws {
        try makeImage(tmp)
        try tmp.mkdir("data/macos-vm/slots")
        let r = try run("localmost-macvm", runArgs)
        XCTAssertEqual(r.status, 64)
        XCTAssertTrue((r.events.last?["message"] as? String)?.contains("cannot be opened") == true)
    }

    private var runArgs: [String] {
        ["run", "--data-dir", tmp.path + "/data", "--image-id", "a1b2c3d4e5f6", "--vm-id", "1-0123456789ab", "--proxy-port", "41000",
         "--broker-port", "8787", "--cpus", "4", "--memory-mib", "6144", "--boot", "cold"]
    }

    func testAThirdMacOSVMIsRefusedWhileTheSlotIsHeld() throws {
        try makeImage(tmp)
        try tmp.mkdir("data/macos-vm/slots")
        try tmp.mkdir("data/macos-vm/vms/1-0123456789ab")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
        p.arguments = ["-e", "use Fcntl ':flock'; open(my $f, '>>', $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print \"held\\n\"; sleep 30;",
                       tmp.real + "/data/macos-vm/slots/1.lock"]
        let out = Pipe()
        p.standardOutput = out
        try p.run()
        defer { p.terminate(); p.waitUntilExit() }
        XCTAssertEqual(String(decoding: out.fileHandleForReading.availableData, as: UTF8.self), "held\n")

        let r = try run("localmost-macvm", runArgs)
        XCTAssertEqual(r.status, ErrorCode.slot.exitCode)
        XCTAssertEqual(r.events.last?["code"] as? String, "E_SLOT")
        // Refused before it cloned anything.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tmp.sub("data/macos-vm/vms/1-0123456789ab")), [])
    }

    func testAnUnfinishedImageIsNeverBooted() throws {
        try makeImage(tmp)
        try FileManager.default.removeItem(atPath: tmp.sub("data/macos-vm/images/a1b2c3d4e5f6/config.json"))
        try tmp.mkdir("data/macos-vm/slots")
        try tmp.mkdir("data/macos-vm/vms/1-0123456789ab")
        let r = try run("localmost-macvm", runArgs)
        XCTAssertEqual(r.status, ErrorCode.image.exitCode)
        XCTAssertTrue((r.events.last?["message"] as? String)?.contains("never finished") == true)
    }

    func testInstallNeverWritesIntoAnImageDirectoryThatHoldsOne() throws {
        try makeImage(tmp)
        try tmp.mkdir("data/macos-vm/slots")
        try tmp.write("data/macos-vm/ipsw/r.ipsw", Data("not really".utf8))
        let r = try run("localmost-macvm", ["install", "--data-dir", tmp.path + "/data", "--image-id", "a1b2c3d4e5f6",
                                            "--ipsw", tmp.path + "/data/macos-vm/ipsw/r.ipsw", "--disk-gib", "64", "--slot", "2"])
        XCTAssertEqual(r.status, ErrorCode.image.exitCode)
        XCTAssertTrue((r.events.last?["message"] as? String)?.contains("already holds") == true)
    }

    func testInstallRefusesALinkedRestoreImage() throws {
        try tmp.mkdir("data/macos-vm/images/a1b2c3d4e5f6")
        try tmp.mkdir("data/macos-vm/slots")
        try tmp.write("elsewhere.ipsw", Data("x".utf8))
        try tmp.mkdir("data/macos-vm/ipsw")
        try tmp.symlink("data/macos-vm/ipsw/r.ipsw", to: tmp.real + "/elsewhere.ipsw")
        let r = try run("localmost-macvm", ["install", "--data-dir", tmp.path + "/data", "--image-id", "a1b2c3d4e5f6",
                                            "--ipsw", tmp.path + "/data/macos-vm/ipsw/r.ipsw", "--disk-gib", "64", "--slot", "1"])
        XCTAssertEqual(r.status, ErrorCode.ipsw.exitCode)
    }

    func testCheckReportsAnImageWhoseModelCannotBeRead() throws {
        try makeImage(tmp)
        let r = try run("localmost-macvm", ["check", "--data-dir", tmp.path + "/data", "--image-id", "a1b2c3d4e5f6"])
        XCTAssertEqual(r.status, ErrorCode.image.exitCode)
        XCTAssertEqual(r.events.last?["ok"] as? Bool, false)
        XCTAssertEqual(r.events.last?["code"] as? String, "E_IMAGE")
    }

    func testTheAgentsPrivilegedCommandsRefuseAnyoneButRoot() throws {
        XCTAssertNotEqual(getuid(), 0, "the suite never runs as root")
        let version = try run("localmost-macvm-agent", ["version"])
        XCTAssertEqual(version.status, 0)
        XCTAssertEqual(version.events.first?["agent"] as? String, agentVersion)
        XCTAssertEqual(try run("localmost-macvm-agent", ["setup"]).status, 77)
        XCTAssertEqual(try run("localmost-macvm-agent", ["exec-as", "--user", "root", "--dir", "/", "--", "/bin/sh"]).status, 64)
        XCTAssertEqual(try run("localmost-macvm-agent", ["kill-all", "--user", "root"]).status, 64)
        XCTAssertEqual(try run("localmost-macvm-agent", ["shell"]).status, 64)
    }
}
