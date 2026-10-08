import XCTest
@testable import MacVMCore

/// The command line: every flag known to its command, once, in its form.
final class ArgsTests: XCTestCase {
    private let data = "/Users/u/.localmost"

    private func run(_ extra: [String: String] = [:], drop: String? = nil) -> [String] {
        var flags = ["--data-dir": data, "--image-id": "a1b2c3d4e5f6", "--vm-id": "2-0123456789ab", "--proxy-port": "41000",
                     "--broker-port": "8787", "--cpus": "4", "--memory-mib": "6144", "--boot": "restore"]
        extra.forEach { flags[$0.key] = $0.value }
        if let drop = drop { flags[drop] = nil }
        return ["run"] + flags.sorted { $0.key < $1.key }.flatMap { [$0.key, $0.value] }
    }

    private func refused(_ argv: [String], _ match: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try parseCommand(argv), file: file, line: line) { error in
            guard let e = error as? HelperError else { return XCTFail("not a HelperError: \(error)", file: file, line: line) }
            XCTAssertEqual(e.code, .args, file: file, line: line)
            XCTAssertTrue(e.message.contains(match), "\(e.message) does not mention \(match)", file: file, line: line)
        }
    }

    func testVersionAndCatalogTakeNoArguments() throws {
        XCTAssertEqual(try parseCommand(["version"]), .version)
        XCTAssertEqual(try parseCommand(["catalog"]), .catalog)
        refused(["version", "x"], "no arguments")
        refused(["catalog", "--data-dir", data], "no arguments")
        refused([], "no command")
        refused(["boot"], "unknown command")
    }

    func testRunParsesEveryFlag() throws {
        XCTAssertEqual(try parseCommand(run()), .run(RunArgs(
            dataDir: data, imageId: "a1b2c3d4e5f6", vmId: "2-0123456789ab", slot: 2, proxyPort: 41000, brokerPort: 8787,
            cpus: 4, memoryMiB: 6144, boot: .restore)))
    }

    func testRunRefusesWhatIsNotInItsForm() {
        refused(run(["--vm-id": "3-0123456789ab"]), "--vm-id")
        refused(run(["--vm-id": "0-0123456789ab"]), "--vm-id")
        refused(run(["--vm-id": "1-0123456789AB"]), "--vm-id")
        refused(run(["--vm-id": "1-0123456789ab\n"]), "--vm-id")
        refused(run(["--image-id": "../../etc"]), "--image-id")
        refused(run(["--proxy-port": "0"]), "--proxy-port")
        refused(run(["--proxy-port": "8787"]), "both 8787")
        refused(run(["--cpus": "1"]), "--cpus")
        refused(run(["--memory-mib": "2048"]), "--memory-mib")
        refused(run(["--cpus": "04"]), "--cpus")
        refused(run(["--boot": "warm"]), "--boot")
        refused(run(["--data-dir": "relative"]), "plain absolute path")
        refused(run(["--data-dir": "/a/../b"]), "plain absolute path")
        refused(run(["--data-dir": "/a//b"]), "plain absolute path")
        refused(run(["--data-dir": "/a/"]), "plain absolute path")
        refused(run(drop: "--broker-port"), "--broker-port is required")
        refused(run() + ["--share", "/x"], "unknown argument")
        refused(run() + ["--cpus", "4"], "given twice")
        refused(run() + ["--cpus"], "needs a value")
    }

    func testInstallTakesARestoreImageOnlyFromTheDataDirectory() throws {
        let ipsw = data + "/macos-vm/ipsw/UniversalMac_26.6.2_25G83_Restore.ipsw"
        let argv = ["install", "--data-dir", data, "--image-id", "a1b2c3d4e5f6", "--ipsw", ipsw, "--disk-gib", "100", "--slot", "1"]
        XCTAssertEqual(try parseCommand(argv), .install(InstallArgs(dataDir: data, imageId: "a1b2c3d4e5f6", ipsw: ipsw, diskGiB: 100, slot: 1)))
        for bad in ["/tmp/x.ipsw", data + "/macos-vm/ipsw/sub/x.ipsw", data + "/macos-vm/ipsw/.x.ipsw", data + "/macos-vm/ipsw/x.zip",
                    data + "/macos-vm/ipsw/a b.ipsw", data + "/macos-vm/ipsw/.ipsw"] {
            var a = argv
            a[6] = bad
            refused(a, "--ipsw")
        }
        var slot3 = argv
        slot3[10] = "3"
        refused(slot3, "--slot")
        var tiny = argv
        tiny[8] = "20"
        refused(tiny, "--disk-gib")
    }

    func testProvisionTakesADisplay() throws {
        let argv = ["provision", "--data-dir", data, "--image-id", "a1b2c3d4e5f6", "--slot", "2", "--display", "window"]
        XCTAssertEqual(try parseCommand(argv), .provision(ProvisionArgs(dataDir: data, imageId: "a1b2c3d4e5f6", slot: 2, display: .window)))
        var bad = argv
        bad[8] = "vnc"
        refused(bad, "--display")
        // No account on the command line, ever.
        refused(argv + ["--password", "x"], "unknown argument")
    }

    func testSaveStateAndCheck() throws {
        XCTAssertEqual(try parseCommand(["save-state", "--data-dir", data, "--image-id", "a1b2c3d4e5f6", "--slot", "1", "--cpus", "4",
                                         "--memory-mib", "6144"]),
                       .saveState(SaveStateArgs(dataDir: data, imageId: "a1b2c3d4e5f6", slot: 1, cpus: 4, memoryMiB: 6144)))
        XCTAssertEqual(try parseCommand(["check", "--data-dir", data, "--image-id", "a1b2c3d4e5f6"]),
                       .check(CheckArgs(dataDir: data, imageId: "a1b2c3d4e5f6")))
        refused(["check", "--data-dir", data], "--image-id is required")
    }

    func testVMIdsAndImageIds() {
        XCTAssertTrue(isVMId("1-0123456789ab"))
        XCTAssertTrue(isVMId("2-ffffffffffff"))
        for bad in ["3-0123456789ab", "12-0123456789ab", "1-0123456789a", "1_0123456789ab", "1-0123456789abc", ""] {
            XCTAssertFalse(isVMId(bad), bad)
        }
        XCTAssertTrue(isImageId("0123456789ab"))
        XCTAssertFalse(isImageId("0123456789aB"))
        XCTAssertFalse(isImageId("0123456789a"))
    }
}
