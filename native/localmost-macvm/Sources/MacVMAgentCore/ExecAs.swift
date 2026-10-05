// How the agent, root, starts the job's runner as the job user: through
// `launchctl asuser`, so that the runner is in the job user's login session
// (a job that runs UI tests or the simulator needs the window server), and
// then through the agent's own `exec-as`, which gives up root for good
// before it execs - checked, not assumed.

import Foundation

/// `launchctl asuser <uid> <agent> exec-as --user <user> --dir <dir> -- <program> <args...>`.
public func execAsArgv(uid: uid_t, agent: String, dir: String, program: String, args: [String]) -> [String] {
    ["/bin/launchctl", "asuser", String(uid), agent, "exec-as", "--user", jobUser, "--dir", dir, "--", program] + args
}

public struct ExecAs: Equatable {
    public var user: String
    public var dir: String
    public var argv: [String]
}

/// Parses what follows `exec-as`. Only the job user, an absolute directory
/// under the job user's home, and a program in that directory are accepted:
/// the subcommand is reachable by anyone who can run the agent binary, and
/// as anyone but root it can do nothing, but as root it must do only this.
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
    guard dir.hasPrefix(home), !dir.split(separator: "/").contains(".."), !dir.contains("//") else {
        throw ProtocolError("exec-as runs only in a directory under \(jobUserHome)")
    }
    guard let first = program.first, first.hasPrefix(dir + "/"), !first.split(separator: "/").contains("..") else {
        throw ProtocolError("exec-as runs only a program in its directory")
    }
    return ExecAs(user: user, dir: dir, argv: program)
}
