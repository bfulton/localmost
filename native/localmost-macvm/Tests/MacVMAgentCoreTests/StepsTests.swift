import XCTest
@testable import MacVMAgentCore
@testable import MacVMCore

/// What a `localmost test` run may ask of the agent, and the files it hands the job user.
final class StepsTests: XCTestCase {
    private func refused<T>(_ body: @autoclosure () throws -> T, _ match: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            let message = (error as? ProtocolError)?.message ?? "\(error)"
            XCTAssertTrue(message.contains(match), "\(message) does not mention \(match)", file: file, line: line)
        }
    }

    private let sha = String(repeating: "a", count: 64)

    func testUploadsGoOnlyToTheWorkspaceOrAnActionsDirectory() throws {
        XCTAssertEqual(try parsePut(["dest": "workspace", "bytes": 10, "sha256": sha]).dest, "workspace")
        XCTAssertEqual(try parsePut(["dest": "actions/0123456789abcdef", "bytes": 10, "sha256": sha]).dest, "actions/0123456789abcdef")
        for dest in ["", "/", "../workspace", "workspace/x", "actions", "actions/", "actions/0123456789ABCDEF", "actions/0123456789abcdef/x",
                     "actions/../workspace", "/Users/runner/work/workspace", "tmp"] {
            refused(try parsePut(["dest": dest, "bytes": 10, "sha256": sha]), "dest")
        }
        refused(try parsePut(["dest": "workspace", "bytes": maxPutBytes + 1, "sha256": sha]), "bytes")
        refused(try parsePut(["dest": "workspace", "bytes": 0, "sha256": sha]), "bytes")
        refused(try parsePut(["dest": "workspace", "bytes": true, "sha256": sha]), "bytes")
        refused(try parsePut(["dest": "workspace", "bytes": 10, "sha256": "x"]), "sha256")
    }

    func testAShellStepTakesAScriptAndNodeAnEntryPoint() throws {
        let shell = try parseStep(["program": "bash", "script": "echo hi", "cwd": "workspace", "env": [:] as [String: Any]])
        XCTAssertEqual(shell.program, .bash)
        XCTAssertEqual(shell.script, "echo hi")
        XCTAssertNil(shell.entry)
        let node = try parseStep(["program": "node", "entry": "actions/0123456789abcdef/dist/index.js", "cwd": "workspace/sub",
                                  "env": [:] as [String: Any]])
        XCTAssertEqual(node.entry, "actions/0123456789abcdef/dist/index.js")
        XCTAssertEqual(node.cwd, "workspace/sub")
        XCTAssertEqual(try parseStep(["program": "node", "entry": "workspace/.github/actions/x/index.js", "cwd": "workspace",
                                      "env": [:] as [String: Any]]).program, .node)

        refused(try parseStep(["program": "python3", "script": "x", "cwd": "workspace", "env": [:] as [String: Any]]), "program")
        refused(try parseStep(["program": "/bin/bash", "script": "x", "cwd": "workspace", "env": [:] as [String: Any]]), "program")
        refused(try parseStep(["program": "bash", "cwd": "workspace", "env": [:] as [String: Any]]), "script")
        refused(try parseStep(["program": "bash", "script": "x", "entry": "workspace/a.js", "cwd": "workspace", "env": [:] as [String: Any]]),
                "no entry")
        refused(try parseStep(["program": "bash", "script": String(repeating: "x", count: maxStepScriptBytes + 1), "cwd": "workspace",
                               "env": [:] as [String: Any]]), "at most")
        refused(try parseStep(["program": "bash", "script": "a\u{0}b", "cwd": "workspace", "env": [:] as [String: Any]]), "script")
        refused(try parseStep(["program": "node", "script": "x", "entry": "workspace/a.js", "cwd": "workspace", "env": [:] as [String: Any]]),
                "no script")
        for entry in ["/etc/x.js", "../x.js", "workspace/../../x.js", "tmp/x.js", "workspace", "workspace//a.js", "actionsx/a.js",
                      "actions/0123456789abcdef", "actions/0123456789/a.js"] {
            refused(try parseStep(["program": "node", "entry": entry, "cwd": "workspace", "env": [:] as [String: Any]]), "entry")
        }
    }

    func testAStepStartsInTheWorkspaceOrUnderIt() throws {
        for cwd in ["workspace", "workspace/a/b", "workspace/.hidden"] {
            XCTAssertEqual(try parseStep(["program": "sh", "script": "x", "cwd": cwd, "env": [:] as [String: Any]]).cwd, cwd)
        }
        for cwd in ["", "/", "/Users/runner", "workspace/..", "workspace/../..", "workspace/./a", "workspace//a", "workspace/", "workspacex",
                    "actions/0123456789abcdef", "tmp"] {
            refused(try parseStep(["program": "sh", "script": "x", "cwd": cwd, "env": [:] as [String: Any]]), "cwd")
        }
    }

    func testAStepsEnvironmentIsTheJobsAllowlistPlusGitHubsAndTheRunnersVariables() throws {
        func step(_ env: [String: Any]) -> [String: Any] { ["program": "bash", "script": "x", "cwd": "workspace", "env": env] }
        let ok = try parseStep(step(["GITHUB_WORKSPACE": "/Users/runner/work/workspace", "RUNNER_TEMP": "/t", "INPUT_NAME": "a\nb",
                                     "GIT_HTTP_PROXY_AUTHMETHOD": "basic", "HTTPS_PROXY": "http://a:b@127.0.0.1:1", "MATRIX_OS": "macos"]))
        XCTAssertEqual(ok.env.count, 6)
        XCTAssertEqual(ok.env["INPUT_NAME"], "a\nb", "a step's values may span lines")
        for name in ["DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "PATH", "HOME", "TMPDIR", "BASH_ENV", "ENV", "NODE_OPTIONS", "DOTNET_STARTUP_HOOKS",
                     "GITHUB_A-B", "RUNNER_É", "1GITHUB", "", String(repeating: "G", count: 129)] {
            refused(try parseStep(step([name: "x"])), "not one a step may set")
        }
        refused(try parseStep(step(["LANG": "a\u{0}b"])), "at most")
        refused(try parseStep(step(["LANG": String(repeating: "x", count: maxStepEnvValueBytes + 1)])), "at most")
        refused(try parseStep(step(["LANG": 1])), "at most")
        let many = Dictionary(uniqueKeysWithValues: (0...maxStepEnvNames).map { ("V\($0)", "x" as Any) })
        refused(try parseStep(step(many)), "at most \(maxStepEnvNames) names")
    }

    func testTheAgentsOwnValuesWinOverWhatTheStepWasGiven() {
        let spec = StepSpec(program: .bash, script: "x", entry: nil, cwd: "workspace",
                            env: ["GITHUB_OUTPUT": "/Users/runner/work/workspace/out", "GITHUB_SHA": "abc", "LANG": "C"])
        let env = stepEnvironment(spec, home: "/Users/runner", outputs: "/var/db/localmost/run/output-1")
        XCTAssertEqual(env["GITHUB_OUTPUT"], "/var/db/localmost/run/output-1")
        XCTAssertEqual(env["HOME"], "/Users/runner")
        XCTAssertEqual(env["TMPDIR"], "/Users/runner/tmp")
        XCTAssertEqual(env["USER"], "runner")
        XCTAssertEqual(env["GITHUB_SHA"], "abc")
        XCTAssertEqual(env["LANG"], "C")
        XCTAssertNotNil(env["PATH"])
    }

    func testAStepRunsAGuestShellOrTheNewestRunnersNewestNode() {
        let externals = ["2.330.0": ["node20", "node24", "node+5", "nodeabc", "node1234", "git"], "2.331.0": ["node20"], "2.9.0": ["node99"]]
        let nodes = { (v: String) in externals[v] ?? [] }
        XCTAssertEqual(stepProgramPath(.bash, runners: [], nodes: nodes), "/bin/bash")
        XCTAssertEqual(stepProgramPath(.sh, runners: [], nodes: nodes), "/bin/sh")
        XCTAssertEqual(stepProgramPath(.zsh, runners: [], nodes: nodes), "/bin/zsh")
        XCTAssertEqual(stepProgramPath(.node, runners: ["2.330.0", "2.9.0"], nodes: nodes), "/usr/local/localmost/runner/2.330.0/externals/node24/bin/node")
        XCTAssertEqual(stepProgramPath(.node, runners: ["2.330.0", "2.331.0"], nodes: nodes), "/usr/local/localmost/runner/2.331.0/externals/node20/bin/node")
        XCTAssertNil(stepProgramPath(.node, runners: [], nodes: nodes))
        XCTAssertNil(stepProgramPath(.node, runners: ["2.332.0"], nodes: nodes))
        XCTAssertNil(stepProgramPath(.node, runners: ["../x"], nodes: { _ in ["node20"] }))
    }

    func testExecAsRunsAStepsShellOrTheRunnersNodeAndNothingElseOutsideItsDirectory() throws {
        XCTAssertTrue(isRunnerNode("/usr/local/localmost/runner/2.330.0/externals/node20/bin/node"))
        for path in ["/usr/local/localmost/runner/2.330.0/externals/node20/bin/node2", "/usr/local/localmost/runner/x/externals/node20/bin/node",
                     "/usr/local/localmost/runner/2.330.0/externals/node20/../../../../bin/sh", "/usr/local/bin/node",
                     "/usr/local/localmost/runner/2.330.0/externals/nodejs/bin/node", "/Users/runner/actions-runner/externals/node20/bin/node"] {
            XCTAssertFalse(isRunnerNode(path), path)
        }
        for program in ["/bin/bash", "/bin/sh", "/bin/zsh", "/usr/bin/tar", "/bin/mkdir", "/usr/local/localmost/runner/2.330.0/externals/node24/bin/node"] {
            let parsed = try parseExecAs(["--user", "runner", "--dir", "/Users/runner/work/workspace", "--", program, "/x"])
            XCTAssertEqual(parsed.argv, [program, "/x"])
        }
        XCTAssertEqual(try parseExecAs(["--user", "runner", "--dir", "/Users/runner", "--", "/bin/mkdir", "-p", "/Users/runner/work"]).dir,
                       "/Users/runner")
        XCTAssertThrowsError(try parseExecAs(["--user", "runner", "--dir", "/Users/runner/work", "--", "/usr/bin/sudo", "id"]))
        XCTAssertThrowsError(try parseExecAs(["--user", "runner", "--dir", "/Users/runner/work", "--", "/bin/../usr/bin/sudo"]))
    }

    // MARK: - The files the agent hands the job user

    private var dir: String!

    override func setUp() {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("steps-\(UUID().uuidString)").path
        try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
        dir = base
    }

    override func tearDown() {
        if let dir = dir, dir.hasPrefix(FileManager.default.temporaryDirectory.path) {
            try? FileManager.default.removeItem(atPath: dir)
        }
    }

    func testAScratchFileIsNewPrivateAndGivenItsMode() throws {
        let scratch = dir + "/run"
        let a = try scratchFile(in: scratch, owner: getuid(), "step", contents: Data("echo hi".utf8), uid: getuid(), gid: getgid(), mode: 0o400)
        let b = try scratchFile(in: scratch, owner: getuid(), "step", contents: Data(), uid: getuid(), gid: getgid(), mode: 0o600)
        XCTAssertNotEqual(a, b)
        XCTAssertTrue(a.hasPrefix(scratch + "/step-"))
        XCTAssertEqual(try String(contentsOfFile: a, encoding: .utf8), "echo hi")
        let attrs = try FileManager.default.attributesOfItem(atPath: a)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o400)
        let dirAttrs = try FileManager.default.attributesOfItem(atPath: scratch)
        XCTAssertEqual((dirAttrs[.posixPermissions] as? NSNumber)?.intValue, 0o711)
    }

    func testAScratchFileIsNeverMadeThroughALinkOrInADirectoryOthersCanWrite() throws {
        let elsewhere = dir + "/elsewhere"
        try FileManager.default.createDirectory(atPath: elsewhere, withIntermediateDirectories: false)
        let linked = dir + "/linked"
        XCTAssertEqual(symlink(elsewhere, linked), 0)
        refused(try scratchFile(in: linked, owner: getuid(), "put", contents: Data(), uid: getuid(), gid: getgid(), mode: 0o400), "only its owner")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: elsewhere), [])

        let open = dir + "/open"
        try FileManager.default.createDirectory(atPath: open, withIntermediateDirectories: false)
        chmod(open, 0o777)
        refused(try scratchFile(in: open, owner: getuid(), "put", contents: Data(), uid: getuid(), gid: getgid(), mode: 0o400), "only its owner")

        let owned = dir + "/owned"
        try FileManager.default.createDirectory(atPath: owned, withIntermediateDirectories: false)
        refused(try scratchFile(in: owned, owner: getuid() + 1, "put", contents: Data(), uid: getuid(), gid: getgid(), mode: 0o400), "only its owner")
    }

    func testOutputsAreReadOnlyFromARegularFileOfBoundedSize() throws {
        var dropped: [String] = []
        let file = dir + "/out"
        try Data("a=1\nb<<EOF\nx\nEOF\n".utf8).write(to: URL(fileURLWithPath: file))
        XCTAssertEqual(readStepOutputs(file, onDropped: { dropped.append($0) }), "a=1\nb<<EOF\nx\nEOF\n")

        let secret = dir + "/secret"
        try Data("token=x".utf8).write(to: URL(fileURLWithPath: secret))
        let link = dir + "/link"
        XCTAssertEqual(symlink(secret, link), 0)
        XCTAssertEqual(readStepOutputs(link, onDropped: { dropped.append($0) }), "", "never through a link")

        let fifo = dir + "/fifo"
        XCTAssertEqual(mkfifo(fifo, 0o600), 0)
        XCTAssertEqual(readStepOutputs(fifo, onDropped: { dropped.append($0) }), "", "never waits on a FIFO")

        XCTAssertEqual(readStepOutputs(dir + "/missing", onDropped: { dropped.append($0) }), "")
        XCTAssertEqual(dropped, [])

        let big = dir + "/big"
        try Data(repeating: 0x61, count: maxStepOutputsBytes + 1).write(to: URL(fileURLWithPath: big))
        XCTAssertEqual(readStepOutputs(big, onDropped: { dropped.append($0) }), "")
        XCTAssertEqual(dropped.count, 1)
        XCTAssertTrue(dropped[0].contains("dropped"))
    }
}
