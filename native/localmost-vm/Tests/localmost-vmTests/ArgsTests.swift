import XCTest
@testable import localmost_vm

/// The argument line of contract §2.1, exactly: every flag, every id form,
/// the mode-specific flags, and nothing else.
final class ArgsTests: XCTestCase {
    private let job: [String: String] = [
        "--vm-id": "3-0123456789ab",
        "--mode": "job",
        "--data-dir": "/Users/u/.localmost",
        "--resources": "/Applications/localmost.app/Contents/Resources",
        "--sandbox-id": "3-a1b2c3d4e5f6",
        "--proxy-port": "54321",
        "--cpus": "4",
        "--memory-mib": "8192",
        "--rosetta": "auto",
    ]

    private var refresh: [String: String] {
        var r = job
        r["--vm-id"] = "0-0123456789ab"
        r["--mode"] = "refresh"
        r["--sandbox-id"] = nil
        r["--proxy-port"] = nil
        r["--repo-key"] = "0123456789abcdef"
        r["--rosetta"] = "off"
        return r
    }

    private func line(_ flags: [String: String]) -> [String] {
        ["run"] + flags.keys.sorted().flatMap { [$0, flags[$0]!] }
    }

    private func parse(_ flags: [String: String]) throws -> RunArgs {
        guard case .run(let args) = try parseCommand(line(flags)) else {
            XCTFail("not a run command")
            throw HelperError(.args, "not run")
        }
        return args
    }

    private func assertRefused(_ argv: [String], _ why: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try parseCommand(argv), why, file: file, line: line) { error in
            XCTAssertEqual((error as? HelperError)?.code, .args, why, file: file, line: line)
        }
    }

    private func assertRefused(_ flags: [String: String], _ why: String, file: StaticString = #filePath, line: UInt = #line) {
        assertRefused(self.line(flags), why, file: file, line: line)
    }

    private func with(_ base: [String: String], _ key: String, _ value: String?) -> [String: String] {
        var f = base
        f[key] = value
        return f
    }

    // MARK: - What is accepted

    func testAJobLineParses() throws {
        let a = try parse(job)
        XCTAssertEqual(a.vmId, "3-0123456789ab")
        XCTAssertEqual(a.slot, 3)
        XCTAssertEqual(a.mode, .job(sandboxId: "3-a1b2c3d4e5f6", proxyPort: 54321))
        XCTAssertEqual(a.dataDir, "/Users/u/.localmost")
        XCTAssertEqual(a.resources, "/Applications/localmost.app/Contents/Resources")
        XCTAssertEqual(a.cpus, 4)
        XCTAssertEqual(a.memoryMiB, 8192)
        XCTAssertEqual(a.rosetta, .auto)
    }

    func testARefreshLineParses() throws {
        let a = try parse(refresh)
        XCTAssertEqual(a.slot, 0)
        XCTAssertEqual(a.mode, .refresh(repoKey: "0123456789abcdef"))
        XCTAssertEqual(a.rosetta, .off)
    }

    func testFlagOrderDoesNotMatter() throws {
        let reversed = ["run"] + job.keys.sorted().reversed().flatMap { [$0, job[$0]!] }
        guard case .run(let a) = try parseCommand(reversed) else { return XCTFail("not run") }
        XCTAssertEqual(a, try parse(job))
    }

    func testTheBoundsOfEveryNumberAreAccepted() throws {
        XCTAssertEqual(try parse(with(job, "--cpus", "1")).cpus, 1)
        XCTAssertEqual(try parse(with(job, "--cpus", "64")).cpus, 64)
        XCTAssertEqual(try parse(with(job, "--memory-mib", "1024")).memoryMiB, 1024)
        XCTAssertEqual(try parse(with(job, "--memory-mib", "65536")).memoryMiB, 65536)
        XCTAssertEqual(try parse(with(job, "--proxy-port", "1")).mode, .job(sandboxId: "3-a1b2c3d4e5f6", proxyPort: 1))
        XCTAssertEqual(try parse(with(job, "--proxy-port", "65535")).mode, .job(sandboxId: "3-a1b2c3d4e5f6", proxyPort: 65535))
        XCTAssertEqual(try parse(with(job, "--vm-id", "99-0123456789ab")).slot, 99)
    }

    func testVersionTakesNoArguments() throws {
        XCTAssertEqual(try parseCommand(["version"]), .version)
        assertRefused(["version", "--mode", "job"], "version with a flag")
    }

    // MARK: - Commands and flags

    func testNoCommandOrAnUnknownOneIsRefused() {
        assertRefused([], "no command")
        assertRefused(["start"], "an unknown command")
        assertRefused(["--vm-id", "3-0123456789ab"], "a flag without a command")
    }

    func testAnUnknownFlagIsRefused() {
        assertRefused(with(job, "--share", "/Users/u"), "--share is not a flag: the helper derives the share")
        assertRefused(with(job, "--kernel", "/tmp/k"), "--kernel is not a flag")
        assertRefused(line(job) + ["--verbose"], "a trailing flag with no value")
        assertRefused(line(job) + ["extra"], "a stray positional argument")
    }

    func testAFlagGivenTwiceIsRefused() {
        assertRefused(line(job) + ["--cpus", "2"], "--cpus twice")
        assertRefused(line(job) + ["--vm-id", "3-0123456789ab"], "the same --vm-id twice")
    }

    func testTheEqualsFormIsNotAFlag() {
        var argv = line(with(job, "--cpus", nil))
        argv.append("--cpus=4")
        assertRefused(argv, "--cpus=4")
    }

    func testAMissingValueIsRefused() {
        var argv = line(job)
        argv.removeLast()
        assertRefused(argv, "the last flag has no value")
    }

    func testEveryCommonFlagIsRequired() {
        for key in ["--vm-id", "--mode", "--data-dir", "--resources", "--cpus", "--memory-mib", "--rosetta"] {
            assertRefused(with(job, key, nil), "job without \(key)")
            assertRefused(with(refresh, key, nil), "refresh without \(key)")
        }
    }

    // MARK: - Mode-specific flags

    func testJobModeRequiresItsFlagsAndRefusesRefreshOnes() {
        assertRefused(with(job, "--sandbox-id", nil), "job without --sandbox-id")
        assertRefused(with(job, "--proxy-port", nil), "job without --proxy-port")
        assertRefused(with(job, "--repo-key", "0123456789abcdef"), "job with --repo-key")
    }

    func testRefreshModeRequiresItsFlagAndRefusesJobOnes() {
        assertRefused(with(refresh, "--repo-key", nil), "refresh without --repo-key")
        assertRefused(with(refresh, "--sandbox-id", "3-a1b2c3d4e5f6"), "refresh with --sandbox-id")
        assertRefused(with(refresh, "--proxy-port", "54321"), "refresh with --proxy-port")
    }

    func testAnUnknownModeIsRefused() {
        assertRefused(with(job, "--mode", "JOB"), "mode in upper case")
        assertRefused(with(job, "--mode", "build"), "an unknown mode")
    }

    // MARK: - Id forms (§1)

    func testVmIdForm() {
        for bad in ["3-0123456789a", "3-0123456789abc", "3-0123456789AB", "03-0123456789ab", "100-0123456789ab",
                    "-1-0123456789ab", "3_0123456789ab", "3-0123456789ag", "", "3-0123456789ab\n", " 3-0123456789ab",
                    "3-0123456789ab/..", "../3-0123456789ab"] {
            assertRefused(with(job, "--vm-id", bad), "vm id \(bad.debugDescription)")
        }
    }

    func testSlotZeroIsOnlyARefreshAndARefreshIsOnlySlotZero() {
        assertRefused(with(job, "--vm-id", "0-0123456789ab"), "a job VM in slot 0")
        assertRefused(with(refresh, "--vm-id", "1-0123456789ab"), "a refresh VM in slot 1")
        assertRefused(with(refresh, "--vm-id", "00-0123456789ab"), "slot 00 does not read as the refresh slot")
    }

    func testSandboxIdForm() {
        for bad in ["3-a1b2c3d4e5f", "3-A1B2C3D4E5F6", "03-a1b2c3d4e5f6", "100-a1b2c3d4e5f6", "..", "3-a1b2c3d4e5f6/_work",
                    "../../../..", "3-a1b2c3d4e5f6 "] {
            assertRefused(with(job, "--sandbox-id", bad), "sandbox id \(bad.debugDescription)")
        }
    }

    func testRepoKeyForm() {
        for bad in ["0123456789abcde", "0123456789abcdef0", "0123456789ABCDEF", "0123456789abcdeg", "../0123456789ab"] {
            assertRefused(with(refresh, "--repo-key", bad), "repo key \(bad.debugDescription)")
        }
    }

    // MARK: - Paths and numbers

    func testPathsMustBeAbsolute() {
        for bad in ["", "relative/dir", "./x", "~/.localmost"] {
            assertRefused(with(job, "--data-dir", bad), "data dir \(bad.debugDescription)")
            assertRefused(with(job, "--resources", bad), "resources \(bad.debugDescription)")
        }
        assertRefused(with(job, "--data-dir", "/Users/u/\0x"), "a NUL in a path")
    }

    func testNumbersOutOfRangeOrMalformedAreRefused() {
        for bad in ["0", "65", "-1", "+4", "04", "4.0", "4 ", "", "four", "9999999999999999999999"] {
            assertRefused(with(job, "--cpus", bad), "cpus \(bad.debugDescription)")
        }
        for bad in ["1023", "65537", "08192", "8g"] {
            assertRefused(with(job, "--memory-mib", bad), "memory \(bad.debugDescription)")
        }
        for bad in ["0", "65536", "080", "-80"] {
            assertRefused(with(job, "--proxy-port", bad), "proxy port \(bad.debugDescription)")
        }
    }

    func testRosettaIsAutoOrOff() {
        assertRefused(with(job, "--rosetta", "on"), "rosetta on")
        assertRefused(with(job, "--rosetta", "install"), "rosetta install: localmost never installs Rosetta")
    }
}
