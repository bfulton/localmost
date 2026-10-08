import XCTest
@testable import MacVMAgentCore
@testable import MacVMCore

/// How the agent hands a job's or step's environment to exec-as: never to
/// root's side of the exec chain, only to the program, once it is the job user.
final class ExecAsTests: XCTestCase {
    private func refused<T>(_ body: @autoclosure () throws -> T, _ match: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            let message = (error as? ProtocolError)?.message ?? "\(error)"
            XCTAssertTrue(message.contains(match), "\(message) does not mention \(match)", file: file, line: line)
        }
    }

    private let envFile = stepScratchDir + "/env-0123456789abcdef"

    func testRootsSideOfTheExecChainIsStartedWithTheFixedEnvironmentAlone() {
        XCTAssertEqual(rootSideEnvironment, ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"])
        let launch = execAsLaunch(uid: 502, agent: "/a", dir: "/Users/runner/actions-runner", envFile: envFile,
                                  program: "/Users/runner/actions-runner/run.sh", args: ["--once"])
        XCTAssertEqual(launch.env, rootSideEnvironment)
        XCTAssertEqual(launch.argv, ["/bin/launchctl", "asuser", "502", "/a", "exec-as", "--user", "runner", "--dir", "/Users/runner/actions-runner",
                                     "--env-file", envFile, "--", "/Users/runner/actions-runner/run.sh", "--once"])
    }

    func testExecAsTakesAnEnvFileOnlyFromTheAgentsScratchDirectory() throws {
        let parsed = try parseExecAs(["--user", "runner", "--dir", "/Users/runner/work/workspace", "--env-file", envFile, "--", "/bin/bash", "/x"])
        XCTAssertEqual(parsed.envFile, envFile)
        XCTAssertEqual(parsed.argv, ["/bin/bash", "/x"])
        XCTAssertNil(try parseExecAs(["--user", "runner", "--dir", "/Users/runner", "--", "/bin/mkdir", "-p", "/Users/runner/work"]).envFile)
        for file in ["/tmp/env-0123456789abcdef", stepScratchDir + "/env-0123456789ABCDEF", stepScratchDir + "/env-0123456789abcde",
                     stepScratchDir + "/output-0123456789abcdef", stepScratchDir + "/env-0123456789abcdef/../x", "/Users/runner/env"] {
            refused(try parseExecAs(["--user", "runner", "--dir", "/Users/runner/work", "--env-file", file, "--", "/bin/bash", "/x"]),
                    "env file only from")
        }
        refused(try parseExecAs(["--user", "runner", "--dir", "/Users/runner/work", "--env-file", envFile, "/bin/bash"]), "usage")
        refused(try parseExecAs(["--user", "runner", "--dir", "/Users/runner/work", "--env-file"]), "usage")
    }

    func testAnEnvFileCarriesOnlyNamesExecAsPassesOn() throws {
        let env = ["HTTPS_PROXY": "http://t:s@127.0.0.1:41000", "LANG": "C", "GITHUB_SHA": "abc", "HOME": "/Users/runner", "EMPTY": ""]
        XCTAssertEqual(try parseEnvFile(encodeEnvFile(env)), env)
        XCTAssertEqual(try parseEnvFile(Data()), [:])
        for name in ["DYLD_INSERT_LIBRARIES", "BASH_ENV", "NODE_OPTIONS", "PWD", "1X", "A-B", ""] {
            refused(try parseEnvFile(Data("\(name)=x\u{0}".utf8)), "is not one exec-as passes on")
        }
        refused(try parseEnvFile(Data("LANG=C".utf8)), "does not end")
        refused(try parseEnvFile(Data("LANG\u{0}".utf8)), "no =")
        refused(try parseEnvFile(Data("LANG=C\u{0}LANG=D\u{0}".utf8)), "twice")
        refused(try parseEnvFile(Data("LANG=\(String(repeating: "x", count: maxStepEnvValueBytes + 1))\u{0}".utf8)), "over")
        // A value may hold an =; only the first one ends the name.
        XCTAssertEqual(try parseEnvFile(Data("NO_PROXY=a=b\u{0}".utf8)), ["NO_PROXY": "a=b"])
    }

    func testTheProgramGetsExactlyTheFilteredEnvironmentAndTheAgentsOwnValues() throws {
        // A job: what runnerEnvironment made of its allowed names, through the file.
        let job = JobSpec(runnerVersion: "2.330.0", files: [:], env: ["HTTPS_PROXY": "p", "LANG": "C", "TZ": "UTC"], args: ["--once"])
        let jobEnv = runnerEnvironment(job, home: jobUserHome)
        XCTAssertEqual(execAsEnvironment(try parseEnvFile(encodeEnvFile(jobEnv)), home: jobUserHome), jobEnv)
        // A step: what stepEnvironment made, GITHUB_OUTPUT included.
        let step = StepSpec(program: .bash, script: "x", entry: nil, cwd: "workspace", env: ["GITHUB_SHA": "abc", "LANG": "C"])
        let stepEnv = stepEnvironment(step, home: jobUserHome, outputs: stepScratchDir + "/output-0123456789abcdef")
        XCTAssertEqual(execAsEnvironment(try parseEnvFile(encodeEnvFile(stepEnv)), home: jobUserHome), stepEnv)
        // The agent's own values win over the file's, and stand alone without one.
        let forged = execAsEnvironment(["HOME": "/tmp", "PATH": "/tmp/bin", "LANG": "C"], home: jobUserHome)
        XCTAssertEqual(forged["HOME"], jobUserHome)
        XCTAssertEqual(forged["PATH"], "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        XCTAssertEqual(forged["LANG"], "C")
        XCTAssertEqual(Set(execAsEnvironment([:], home: jobUserHome).keys), agentEnvNames)
    }

    // MARK: - Reading the file

    private var dir: String!

    override func setUp() {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("execas-\(UUID().uuidString)").path
        try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
        chmod(base, 0o711)
        dir = base
    }

    override func tearDown() {
        if let dir = dir, dir.hasPrefix(FileManager.default.temporaryDirectory.path) {
            try? FileManager.default.removeItem(atPath: dir)
        }
    }

    private func write(_ name: String, _ text: String, mode: mode_t = 0o600) -> String {
        let path = dir + "/" + name
        FileManager.default.createFile(atPath: path, contents: Data(text.utf8))
        chmod(path, mode)
        return path
    }

    func testAnEnvFileIsReadOnlyFromAPrivateRegularFileOfItsOwner() throws {
        let ok = write("env-ok", "LANG=C\u{0}")
        XCTAssertEqual(try readEnvFile(ok, owner: getuid()), Data("LANG=C\u{0}".utf8))
        refused(try readEnvFile(ok, owner: getuid() + 1), "owner")

        let shared = write("env-shared", "LANG=C\u{0}", mode: 0o644)
        refused(try readEnvFile(shared, owner: getuid()), "private file")

        let link = dir + "/env-link"
        XCTAssertEqual(symlink(ok, link), 0)
        refused(try readEnvFile(link, owner: getuid()), "cannot be opened")

        let hard = dir + "/env-hard"
        XCTAssertEqual(Darwin.link(ok, hard), 0)
        refused(try readEnvFile(hard, owner: getuid()), "private file")
        unlink(hard)

        let fifo = dir + "/env-fifo"
        XCTAssertEqual(mkfifo(fifo, 0o600), 0)
        refused(try readEnvFile(fifo, owner: getuid()), "private file")

        let big = write("env-big", String(repeating: "x", count: maxEnvFileBytes + 1))
        refused(try readEnvFile(big, owner: getuid()), "private file")

        chmod(dir, 0o777)
        refused(try readEnvFile(ok, owner: getuid()), "only its owner can write")
    }

    // MARK: - Signals to a test run's steps

    func testAKillReachesEveryProcessOfTheJobUserAndNotAGroupWhosePidWasReused() {
        let groups: [Int32: Bool] = [100: false, 200: true, 300: true]
        let alive: (Int32) -> Bool = { $0 == 200 }
        let kill = stepSignalTargets(groups, signal: .KILL, alive: alive)
        XCTAssertEqual(kill.groups, [100, 300])
        XCTAssertTrue(kill.allOfJobUser)
        let term = stepSignalTargets(groups, signal: .TERM, alive: alive)
        XCTAssertEqual(term.groups, [100, 300])
        XCTAssertFalse(term.allOfJobUser)
        XCTAssertTrue(stepSignalTargets([:], signal: .KILL, alive: alive).allOfJobUser)
    }
}
