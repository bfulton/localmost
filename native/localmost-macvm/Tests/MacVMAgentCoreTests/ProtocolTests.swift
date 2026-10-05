import XCTest
@testable import MacVMAgentCore
@testable import MacVMCore

/// What the agent accepts from the host, and what its setup does.
final class ProtocolTests: XCTestCase {
    private func refused<T>(_ body: @autoclosure () throws -> T, _ match: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            let message = (error as? ProtocolError)?.message ?? "\(error)"
            XCTAssertTrue(message.contains(match), "\(message) does not mention \(match)", file: file, line: line)
        }
    }

    func testJobFilesAreExactlyTheRunnersThree() throws {
        let files = [".runner": "{}", ".credentials": "{}", ".credentials_rsaparams": "{}"]
        let base: [String: Any] = ["runnerVersion": "2.330.0", "files": files, "env": [:] as [String: Any], "args": ["--once"]]
        XCTAssertEqual(try parseJob(base).files.count, 3)
        var extra = base
        extra["files"] = files.merging(["../../etc/sudoers": "x"]) { $1 }
        refused(try parseJob(extra), "files must be exactly")
        var missing = base
        missing["files"] = [".runner": "{}"]
        refused(try parseJob(missing), "files must be exactly")
        var big = base
        big["files"] = files.merging([".runner": String(repeating: "a", count: maxJobFileBytes + 1)]) { $1 }
        refused(try parseJob(big), "at most")
    }

    func testTheJobsEnvironmentIsAnAllowlist() throws {
        let files = [".runner": "{}", ".credentials": "{}", ".credentials_rsaparams": "{}"]
        func job(_ env: [String: Any]) -> [String: Any] {
            ["runnerVersion": "2.330.0", "files": files, "env": env, "args": ["--once"]]
        }
        XCTAssertEqual(try parseJob(job(["HTTPS_PROXY": "http://a:b@127.0.0.1:1"])).env["HTTPS_PROXY"], "http://a:b@127.0.0.1:1")
        // What a repository's env policy passes, by name.
        XCTAssertEqual(try parseJob(job(["DEVELOPER_DIR": "/Applications/Xcode.app", "_FLAG": "1"])).env.count, 2)
        for name in [
            "DYLD_INSERT_LIBRARIES", "PATH", "HOME", "BASH_ENV", "LD_PRELOAD", "NODE_OPTIONS", "RUNNER_ALLOW_RUNASROOT",
            "DOTNET_STARTUP_HOOKS", "ACTIONS_RUNNER_HOOK_JOB_STARTED", "GITHUB_TOKEN", "BASH_FUNC_x%%", "1ABC", "A-B", "É", "",
            String(repeating: "A", count: 129),
        ] {
            refused(try parseJob(job([name: "x"])), "not one a job may set")
        }
        refused(try parseJob(job(["LANG": "a\nb"])), "one line")
        refused(try parseJob(job(["LANG": 5])), "one line")
    }

    func testTheRunnerStartsOnlyWithItsAllowedArguments() {
        let files = [".runner": "{}", ".credentials": "{}", ".credentials_rsaparams": "{}"]
        for args in [["--once", "--startuptype", "service"], [], ["--check"]] {
            refused(try parseJob(["runnerVersion": "2.330.0", "files": files, "env": [:] as [String: Any], "args": args]), "args")
        }
        refused(try parseJob(["runnerVersion": "2.330", "files": files, "env": [:] as [String: Any], "args": ["--once"]]), "runnerVersion")
    }

    func testTheRunnersEnvironmentKeepsTheAgentsOwnValues() throws {
        let spec = JobSpec(runnerVersion: "2.330.0", files: [:], env: ["HTTPS_PROXY": "p", "LANG": "C"], args: ["--once"])
        let env = runnerEnvironment(spec, home: "/Users/runner")
        XCTAssertEqual(env["HOME"], "/Users/runner")
        XCTAssertEqual(env["USER"], "runner")
        XCTAssertEqual(env["TMPDIR"], "/Users/runner/tmp")
        XCTAssertEqual(env["HTTPS_PROXY"], "p")
        XCTAssertNotNil(env["PATH"])
    }

    func testPrepareIsChecked() throws {
        let entropy = Data(count: 64).base64EncodedString()
        let ok: [String: Any] = ["timeMs": 1_790_000_000_000, "entropy": entropy, "proxyPort": 41000, "brokerPort": 8787]
        XCTAssertEqual(try parsePrepare(ok).entropy.count, 64)
        var o = ok
        o["timeMs"] = 5
        refused(try parsePrepare(o), "timeMs")
        o = ok
        o["entropy"] = Data(count: 8).base64EncodedString()
        refused(try parsePrepare(o), "entropy")
        o = ok
        o["brokerPort"] = 41000
        refused(try parsePrepare(o), "differ")
        o = ok
        o["proxyPort"] = true
        refused(try parsePrepare(o), "proxyPort")
    }

    func testRunnerUploadsAreChecked() throws {
        let ok: [String: Any] = ["version": "2.331.0", "bytes": 100, "sha256": String(repeating: "0", count: 64)]
        XCTAssertEqual(try parseRunnerUpload(ok).bytes, 100)
        var o = ok
        o["bytes"] = maxRunnerBytes + 1
        refused(try parseRunnerUpload(o), "bytes")
        o = ok
        o["sha256"] = String(repeating: "G", count: 64)
        refused(try parseRunnerUpload(o), "sha256")
        o = ok
        o["version"] = "../2"
        refused(try parseRunnerUpload(o), "version")
    }

    func testExecAsOnlyRunsTheJobUsersRunner() throws {
        let ok = try parseExecAs(["--user", "runner", "--dir", "/Users/runner/actions-runner", "--", "/Users/runner/actions-runner/run.sh", "--once"])
        XCTAssertEqual(ok.argv, ["/Users/runner/actions-runner/run.sh", "--once"])
        refused(try parseExecAs(["--user", "root", "--dir", "/Users/runner/a", "--", "/Users/runner/a/run.sh"]), "only as runner")
        refused(try parseExecAs(["--user", "runner", "--dir", "/tmp", "--", "/tmp/run.sh"]), "under /Users/runner")
        refused(try parseExecAs(["--user", "runner", "--dir", "/Users/runner/a/../..", "--", "/Users/runner/a/run.sh"]), "under /Users/runner")
        refused(try parseExecAs(["--user", "runner", "--dir", "/Users/runner/a", "--", "/bin/sh"]), "in its directory")
        refused(try parseExecAs(["--user", "runner", "--dir", "/Users/runner/a", "--", "/Users/runner/a/../../../bin/sh"]), "in its directory")
        refused(try parseExecAs(["--user", "runner"]), "usage")
        XCTAssertEqual(execAsArgv(uid: 502, agent: "/a", dir: "/Users/runner/x", program: "/Users/runner/x/run.sh", args: ["--once"]),
                       ["/bin/launchctl", "asuser", "502", "/a", "exec-as", "--user", "runner", "--dir", "/Users/runner/x", "--",
                        "/Users/runner/x/run.sh", "--once"])
    }

    func testKcpasswordMatchesTheKnownEncoding() {
        // "password" XORed with the key, NUL-terminated and padded to 12.
        XCTAssertEqual(kcpassword("password").map { String(format: "%02x", $0) }.joined(),
                       "0de82150a5d3af8ea3b91f7d")
        XCTAssertEqual(kcpassword("abcdefghijk").count, 12)
        // Always at least one NUL: since macOS 13, loginwindow wants a
        // password of exactly twelve characters padded to 24.
        XCTAssertEqual(kcpassword("abcdefghijkl").count, 24)
    }

    func testTheNewestCommandLineToolsAreChosen() {
        let output = """
        Software Update Tool

        Finding available software
        Software Update found the following new or updated software:
        * Label: Command Line Tools for Xcode 26.3-26.3
        \tTitle: Command Line Tools for Xcode 26.3, Version: 26.3, Size: 900000KiB, Recommended: YES,
        * Label: Command Line Tools for Xcode 26.10-26.10
        \tTitle: Command Line Tools for Xcode 26.10, Version: 26.10, Size: 900000KiB, Recommended: YES,
        * Label: Safari26.1-26.1
        """
        XCTAssertEqual(newestCommandLineToolsLabel(output), "Command Line Tools for Xcode 26.10-26.10")
        XCTAssertNil(newestCommandLineToolsLabel("No new software available.\n"))
    }

    func testTheSetupMakesAnOrdinaryJobUserAndLeavesNoWayBackIn() throws {
        let inputs = SetupInputs(adminUser: "localmost-admin", adminPassword: "admin-password-123", jobPassword: "job-password-12345",
                                 discardedAdminPassword: "discarded-password-1", runnerVersion: "2.330.0", runnerTarball: "/tmp/lmb/runner.tar.gz",
                                 agentBinary: "/tmp/lmb/localmost-macvm-agent", osVersion: "26.6.2", osBuild: "25G83")
        let plan = setupPlan(inputs)
        let runs = plan.compactMap { step -> [String]? in
            if case .run(_, let argv) = step { return argv }
            return nil
        }
        let addUser = try XCTUnwrap(runs.first { $0.contains("-addUser") })
        XCTAssertFalse(addUser.contains("-admin"), "the job user is never an administrator")
        XCTAssertEqual(addUser[2], "runner")
        XCTAssertTrue(runs.contains(["/bin/launchctl", "disable", "system/com.openssh.sshd"]))
        let reset = try XCTUnwrap(runs.first { $0.contains("-resetPasswordFor") })
        XCTAssertTrue(reset.contains("discarded-password-1"))
        XCTAssertTrue(plan.contains(.installCommandLineTools))
        XCTAssertTrue(plan.contains(.installRunner(version: "2.330.0", tarball: "/tmp/lmb/runner.tar.gz")))
        // The marker, which makes the agent's hello ready, comes after
        // everything a job relies on.
        let marker = try XCTUnwrap(plan.firstIndex { if case .write(_, let p, _, _) = $0 { return p == setupMarker }; return false })
        let agent = try XCTUnwrap(plan.firstIndex(of: .installAgent(from: "/tmp/lmb/localmost-macvm-agent")))
        let clt = try XCTUnwrap(plan.firstIndex(of: .installCommandLineTools))
        XCTAssertGreaterThan(marker, agent)
        XCTAssertGreaterThan(marker, clt)
        // Remote Login goes off last, after the administrator's password.
        XCTAssertEqual(runs.last, ["/bin/launchctl", "disable", "system/com.openssh.sshd"])
        let kc = plan.first { if case .write(_, "/etc/kcpassword", _, let mode) = $0 { return mode == 0o600 }; return false }
        XCTAssertNotNil(kc, "auto-login's password file is root's alone")
    }

    func testTheAgentsDaemonRunsAsRootAndKeepsRunning() throws {
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: agentLaunchDaemonPlist(), format: nil) as? [String: Any])
        XCTAssertEqual(plist["Label"] as? String, agentLabel)
        XCTAssertEqual(plist["ProgramArguments"] as? [String], [agentInstallPath, "serve"])
        XCTAssertEqual(plist["UserName"] as? String, "root")
        XCTAssertEqual(plist["KeepAlive"] as? Bool, true)
    }

    func testSetupInputsAreChecked() throws {
        let ok: [String: Any] = ["adminUser": "localmost-admin", "adminPassword": "admin-password-123", "jobPassword": "job-password-12345",
                                 "discardedAdminPassword": "discarded-password-1", "runnerVersion": "2.330.0",
                                 "runnerTarball": "/tmp/lmb/runner.tar.gz", "agentBinary": "/tmp/lmb/agent", "osVersion": "26.6.2", "osBuild": "25G83"]
        XCTAssertEqual(try parseSetupInputs(try JSONSerialization.data(withJSONObject: ok)).adminUser, "localmost-admin")
        for (key, value) in [("adminUser", "Root"), ("jobPassword", "short"), ("runnerTarball", "relative/x"), ("runnerTarball", "/a/../b"),
                             ("osBuild", "")] {
            var o = ok
            o[key] = value
            refused(try parseSetupInputs(try JSONSerialization.data(withJSONObject: o)), key)
        }
        refused(try parseSetupInputs(Data("[]".utf8)), "not a JSON object")
    }
}
