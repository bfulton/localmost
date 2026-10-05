// How the agent, root, starts the job's runner - or a test run's step - as
// the job user: through `launchctl asuser`, so that it runs in the job
// user's login session (a job that runs UI tests or the simulator needs the
// window server), and then through the agent's own `exec-as`, which gives
// up root for good before it execs - checked, not assumed.
//
// Nothing a job or a step chose reaches code that runs as root. launchctl
// and exec-as are started with rootSideEnvironment and nothing else; the
// environment the program is to get is written by the agent to a file of
// root's (an env file in stepScratchDir), which exec-as reads while still
// root, removes, and applies with execve only once it is the job user. The
// names a job may set are a blocklist (jobEnvNameAllowed), so one it does
// not foresee - TZ, Malloc*, OBJC_*, CFFIXED_USER_HOME - could otherwise
// change how launchctl or the Swift runtime behaves as root.

import Darwin
import Foundation
import MacVMCore

/// The environment of root's side of the exec chain: `launchctl asuser`, and
/// exec-as until it has given up root.
public let rootSideEnvironment: [String: String] = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]

/// `launchctl asuser <uid> <agent> exec-as --user <user> --dir <dir> [--env-file <file>] -- <program> <args...>`.
public func execAsArgv(uid: uid_t, agent: String, dir: String, envFile: String? = nil, program: String, args: [String]) -> [String] {
    ["/bin/launchctl", "asuser", String(uid), agent, "exec-as", "--user", jobUser, "--dir", dir]
        + (envFile.map { ["--env-file", $0] } ?? []) + ["--", program] + args
}

/// What the agent spawns to start a program as the job user: the exec chain's
/// argv, and the environment it is spawned with, which is always
/// rootSideEnvironment - the program's own comes through `envFile`.
public func execAsLaunch(uid: uid_t, agent: String, dir: String, envFile: String?, program: String,
                         args: [String]) -> (argv: [String], env: [String: String]) {
    (execAsArgv(uid: uid, agent: agent, dir: dir, envFile: envFile, program: program, args: args), rootSideEnvironment)
}

/// The guest's own programs exec-as may run besides one in its directory:
/// the shells a step runs in, and what the agent unpacks a test run's
/// uploads with. The runner's node is checked apart (isRunnerNode).
public let execAsSystemPrograms: Set<String> = ["/bin/bash", "/bin/sh", "/bin/zsh", "/bin/mkdir", "/usr/bin/tar"]

public struct ExecAs: Equatable {
    public var user: String
    public var dir: String
    /// The env file the agent left for the program, or nil for the agent's own values alone.
    public var envFile: String?
    public var argv: [String]
}

/// An env file's path: in stepScratchDir, `env-` and 16 lowercase hex, as
/// scratchFile names one.
public func isEnvFilePath(_ s: String) -> Bool {
    let prefix = stepScratchDir + "/env-"
    guard s.hasPrefix(prefix) else { return false }
    let id = s.utf8.dropFirst(prefix.utf8.count)
    return id.count == 16 && id.allSatisfy(isLowerHex)
}

/// Parses what follows `exec-as`. Only the job user, an absolute directory
/// that is the job user's home or under it, an env file of the agent's, and
/// a program in that directory, one of execAsSystemPrograms or a runner's
/// node are accepted: the subcommand is reachable by anyone who can run the
/// agent binary, and as anyone but root it can do nothing, but as root it
/// must do only this.
public func parseExecAs(_ argv: [String]) throws -> ExecAs {
    guard argv.count >= 6, argv[0] == "--user", argv[2] == "--dir" else {
        throw ProtocolError("usage: exec-as --user <user> --dir <dir> [--env-file <file>] -- <program> [args...]")
    }
    var rest = Array(argv[4...])
    var envFile: String?
    if rest.first == "--env-file" {
        guard rest.count >= 2, isEnvFilePath(rest[1]) else {
            throw ProtocolError("exec-as takes an env file only from \(stepScratchDir)")
        }
        envFile = rest[1]
        rest = Array(rest.dropFirst(2))
    }
    guard rest.count >= 2, rest[0] == "--" else {
        throw ProtocolError("usage: exec-as --user <user> --dir <dir> [--env-file <file>] -- <program> [args...]")
    }
    let user = argv[1]
    let dir = argv[3]
    let program = Array(rest.dropFirst())
    guard user == jobUser else {
        throw ProtocolError("exec-as runs only as \(jobUser)")
    }
    let home = jobUserHome + "/"
    guard dir == jobUserHome || dir.hasPrefix(home), !dir.split(separator: "/").contains(".."), !dir.contains("//") else {
        throw ProtocolError("exec-as runs only in \(jobUserHome) or a directory under it")
    }
    let first = program[0]
    let inDir = first.hasPrefix(dir + "/") && !first.split(separator: "/").contains("..")
    guard inDir || execAsSystemPrograms.contains(first) || isRunnerNode(first) else {
        throw ProtocolError("exec-as runs only a program in its directory, a shell, or the runner's node")
    }
    return ExecAs(user: user, dir: dir, envFile: envFile, argv: program)
}

// MARK: - The env file

/// The names the agent sets itself, on top of what a job or step may (runnerEnvironment).
public let agentEnvNames: Set<String> = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR"]

/// The most names, and bytes, an env file may hold: a step's, and the agent's own.
public let maxEnvFileNames = maxStepEnvNames + agentEnvNames.count + 1
public let maxEnvFileBytes = maxEnvFileNames * (maxStepEnvValueBytes + 130)

/// Whether an env file may carry `name`: one a step may be given, or one the agent sets itself.
public func envFileNameAllowed(_ name: String) -> Bool {
    stepEnvNameAllowed(name) || agentEnvNames.contains(name)
}

/// An environment as an env file holds it: `NAME=value` and a NUL for each, by name.
public func encodeEnvFile(_ env: [String: String]) -> Data {
    var data = Data()
    for name in env.keys.sorted() {
        data.append(contentsOf: Array("\(name)=\(env[name]!)".utf8))
        data.append(0)
    }
    return data
}

/// An env file's environment, checked again here: every name one it may
/// carry, each once, every value bounded, every entry NUL-terminated.
public func parseEnvFile(_ data: Data) throws -> [String: String] {
    guard data.count <= maxEnvFileBytes else { throw ProtocolError("the env file is over \(maxEnvFileBytes) bytes") }
    guard data.isEmpty || data.last == 0 else { throw ProtocolError("the env file does not end its last entry") }
    var env: [String: String] = [:]
    for entry in data.split(separator: 0, omittingEmptySubsequences: false).dropLast() {
        guard let eq = entry.firstIndex(of: UInt8(ascii: "=")) else {
            throw ProtocolError("an env file entry has no =")
        }
        let name = String(decoding: entry[entry.startIndex..<eq], as: UTF8.self)
        let value = entry[entry.index(after: eq)...]
        guard envFileNameAllowed(name) else { throw ProtocolError("env \(quoted(name)) is not one exec-as passes on") }
        guard env[name] == nil else { throw ProtocolError("env \(name) is in the env file twice") }
        guard value.count <= maxStepEnvValueBytes else { throw ProtocolError("env \(name) is over \(maxStepEnvValueBytes) bytes") }
        env[name] = String(decoding: value, as: UTF8.self)
        guard env.count <= maxEnvFileNames else { throw ProtocolError("the env file has over \(maxEnvFileNames) names") }
    }
    return env
}

/// Reads an env file the agent left: a regular file, never through a link,
/// of `owner`'s alone (no other link to it, nobody else may read or write
/// it), in a directory of `owner`'s nobody else can write. exec-as reads it
/// as root with `owner` root, before it gives up root.
public func readEnvFile(_ path: String, owner: uid_t) throws -> Data {
    let dir = (path as NSString).deletingLastPathComponent
    var dst = stat()
    guard lstat(dir, &dst) == 0, (dst.st_mode & S_IFMT) == S_IFDIR, dst.st_uid == owner, dst.st_mode & 0o022 == 0 else {
        throw ProtocolError("\(dir) is not a directory only its owner can write")
    }
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { throw ProtocolError("\(path) cannot be opened: \(posixMessage())") }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == owner, st.st_nlink == 1,
          st.st_mode & 0o077 == 0, st.st_size <= maxEnvFileBytes
    else {
        throw ProtocolError("\(path) is not a private file of its owner's of at most \(maxEnvFileBytes) bytes")
    }
    var data = Data()
    var buf = [UInt8](repeating: 0, count: 64 << 10)
    while true {
        let n = read(fd, &buf, buf.count)
        if n < 0, errno == EINTR { continue }
        guard n >= 0 else { throw ProtocolError("\(path) cannot be read: \(posixMessage())") }
        if n == 0 { break }
        data.append(contentsOf: buf[0..<n])
        guard data.count <= maxEnvFileBytes else { throw ProtocolError("\(path) grew past \(maxEnvFileBytes) bytes") }
    }
    return data
}

/// The environment exec-as gives the program once it is the job user: what
/// the env file carried, then the agent's own values, which nothing in the
/// file can replace. With no env file, the agent's own values alone.
public func execAsEnvironment(_ fromFile: [String: String], home: String) -> [String: String] {
    runnerEnvironment(JobSpec(runnerVersion: "", files: [:], env: fromFile, args: []), home: home)
}
