// How the agent, root, starts the job's runner - or a test run's step - as
// the job user: through `launchctl asuser`, so that it runs in the job
// user's login session (a job that runs UI tests or the simulator needs the
// window server), and then through the agent's own `exec-as`, which gives
// up root for good before it execs - checked, not assumed.

import Foundation

/// `launchctl asuser <uid> <agent> exec-as --user <user> --dir <dir> -- <program> <args...>`.
public func execAsArgv(uid: uid_t, agent: String, dir: String, program: String, args: [String]) -> [String] {
    ["/bin/launchctl", "asuser", String(uid), agent, "exec-as", "--user", jobUser, "--dir", dir, "--", program] + args
}

/// The guest's own programs exec-as may run besides one in its directory:
/// the shells a step runs in, and what the agent unpacks a test run's
/// uploads with. The runner's node is checked apart (isRunnerNode).
public let execAsSystemPrograms: Set<String> = ["/bin/bash", "/bin/sh", "/bin/zsh", "/bin/mkdir", "/usr/bin/tar"]

public struct ExecAs: Equatable {
    public var user: String
    public var dir: String
    public var argv: [String]
}

/// Parses what follows `exec-as`. Only the job user, an absolute directory
/// that is the job user's home or under it, and a program in that directory,
/// one of execAsSystemPrograms or a runner's node are accepted: the
/// subcommand is reachable by anyone who can run the agent binary, and as
/// anyone but root it can do nothing, but as root it must do only this.
public func parseExecAs(_ argv: [String]) throws -> ExecAs {
    guard argv.count >= 6, argv[0] == "--user", argv[2] == "--dir", argv[4] == "--" else {
        throw ProtocolError("usage: exec-as --user <user> --dir <dir> -- <program> [args...]")
    }
    let user = argv[1]
    let dir = argv[3]
    let program = Array(argv[5...])
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
    return ExecAs(user: user, dir: dir, argv: program)
}
