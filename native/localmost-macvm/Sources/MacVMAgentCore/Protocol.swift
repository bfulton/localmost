// The guest agent's protocol with Electron, over the helper's agent.sock and
// vsock port 1025 (src/main/isolation/macos-vm/agent-client.ts is the other
// side). The framing is MacVMCore's: NDJSON, 64 KiB lines, `"v":1`.
//
//   agent:    {"event":"hello","agent":"1.0.0","ready":true,"os":"26.6.2","runnerVersions":["2.330.0"]}
//   Electron: {"id":1,"op":"prepare","timeMs":...,"entropy":"<base64>","proxyPort":p,"brokerPort":b}
//   Electron: {"id":2,"op":"runner","version":"2.330.0","bytes":n,"sha256":"<hex>"}  then n raw bytes
//   Electron: {"id":3,"op":"job","runnerVersion":"2.330.0","files":{...},"env":{...},"args":["--once"]}
//   agent:    {"event":"output","stream":"stdout","data":"..."} ...
//   agent:    {"event":"exit","code":0}
//   Electron: {"id":4,"op":"signal","signal":"TERM"}
//
// Instead of a job, a boot can run a `localmost test` run: `put` and `step`,
// in Steps.swift.
//
// Every command is answered `{"id":n,"ok":true,...}` or `{"id":n,"ok":false,
// "code":"...","message":"..."}`. The guest is the job's, so Electron treats
// all of this as hostile input; the agent, for its part, takes commands only
// from the host (vsock peer CID 2) and checks each against an allowlist.

import Foundation
import MacVMCore

/// vsock ports, the same numbers the helper uses.
public enum AgentPorts {
    /// The agent's control port, in the guest.
    public static let control: UInt32 = 1025
    /// On the host: the job's proxy.
    public static let hostProxy: UInt32 = 3128
    /// On the host: the broker.
    public static let hostBroker: UInt32 = 8787
}

/// The vsock address of the host.
public let hostCID: UInt32 = 2

/// The job user the golden image's setup creates: an ordinary account, not
/// an administrator, which runs every job's runner.
public let jobUser = "runner"

/// Where the runner versions live in the guest: root's, readable by all.
public let runnerRoot = "/usr/local/localmost/runner"

/// The most a runner upload may be. The osx-arm64 runner is ~110 MB compressed.
public let maxRunnerBytes = 512 << 20

/// The runner files a job may carry: what the runner reads, nothing else.
public let jobFileNames: Set<String> = [".runner", ".credentials", ".credentials_rsaparams"]

/// The most one job file may be.
public let maxJobFileBytes = 16 << 10

/// The arguments a job's runner may be started with.
public let allowedRunnerArgs: [[String]] = [["--once"]]

/// The runner's own settings a job may carry, whatever the rules below say.
public let jobEnvNames: Set<String> = [
    "ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT", "DOTNET_SYSTEM_NET_DISABLEIPV6",
    "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY",
    "LANG", "LC_ALL", "TZ", "RUNNER_DEBUG", "ACTIONS_RUNNER_DEBUG", "ACTIONS_STEP_DEBUG",
]

/// Names no job may set: what the agent sets itself, and what changes how
/// the shell starts.
public let reservedJobEnvNames: Set<String> = [
    "HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "PWD", "OLDPWD",
    "IFS", "ENV", "BASH_ENV", "ZDOTDIR", "SHELLOPTS", "BASHOPTS", "PS4", "CDPATH", "GLOBIGNORE", "PROMPT_COMMAND",
    "NODE_OPTIONS", "NODE_PATH",
]

/// Prefixes no job's names may have: the loader's, .NET's (the runner is a
/// .NET program), and the runner's, Actions' and GitHub's own settings.
public let reservedJobEnvPrefixes: [String] = [
    "DYLD_", "LD_", "DOTNET_", "COREHOST_", "COMPlus_", "CORECLR_", "RUNNER_", "ACTIONS_", "GITHUB_", "BASH_FUNC_",
]

/// Whether a job may set `name`: one of the runner's settings above, or any
/// other the repository's approved env policy passed - a plain name of at
/// most 128 characters, none of the reserved ones, and with none of their
/// prefixes - since nothing a job sets may change how the loader, the shell
/// or the runner's own code is found.
public func jobEnvNameAllowed(_ name: String) -> Bool {
    if jobEnvNames.contains(name) { return true }
    let bytes = Array(name.utf8)
    func letter(_ b: UInt8) -> Bool { (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || b == 0x5F }
    func digit(_ b: UInt8) -> Bool { b >= 0x30 && b <= 0x39 }
    guard let first = bytes.first, bytes.count <= 128, letter(first), bytes.allSatisfy({ letter($0) || digit($0) }) else {
        return false
    }
    return !reservedJobEnvNames.contains(name) && !reservedJobEnvPrefixes.contains(where: { name.hasPrefix($0) })
}

public struct ProtocolError: Error, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

public struct Prepare: Equatable {
    public var timeMs: Int64
    public var entropy: Data
    public var proxyPort: Int
    public var brokerPort: Int
}

public struct RunnerUpload: Equatable {
    public var version: String
    public var bytes: Int
    public var sha256: String
}

public struct JobSpec: Equatable {
    public var runnerVersion: String
    public var files: [String: String]
    public var env: [String: String]
    public var args: [String]
}

/// Signals Electron may send a job's runner.
public enum JobSignal: String {
    case TERM, INT, KILL

    public var number: Int32 {
        switch self {
        case .TERM: return SIGTERM
        case .INT: return SIGINT
        case .KILL: return SIGKILL
        }
    }
}

/// `^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$`, a runner version.
public func isRunnerVersion(_ s: String) -> Bool {
    let parts = s.split(separator: ".", omittingEmptySubsequences: false)
    return parts.count == 3 && parts.allSatisfy { (1...4).contains($0.count) && $0.utf8.allSatisfy { $0 >= 48 && $0 <= 57 } }
}

private func port(_ value: Any?, _ name: String) throws -> Int {
    guard let n = value as? NSNumber, isInteger(n), portRange.contains(n.intValue) else {
        throw ProtocolError("\(name) must be a port from 1 to 65535")
    }
    return n.intValue
}

public func parsePrepare(_ o: [String: Any]) throws -> Prepare {
    guard let t = o["timeMs"] as? NSNumber, isInteger(t), t.int64Value > 1_600_000_000_000 else {
        throw ProtocolError("timeMs must be the host's time in milliseconds")
    }
    guard let e = o["entropy"] as? String, let entropy = Data(base64Encoded: e), (32...512).contains(entropy.count) else {
        throw ProtocolError("entropy must be 32-512 bytes, base64")
    }
    let proxy = try port(o["proxyPort"], "proxyPort")
    let broker = try port(o["brokerPort"], "brokerPort")
    guard proxy != broker else { throw ProtocolError("proxyPort and brokerPort must differ") }
    return Prepare(timeMs: t.int64Value, entropy: entropy, proxyPort: proxy, brokerPort: broker)
}

public func parseRunnerUpload(_ o: [String: Any]) throws -> RunnerUpload {
    guard let version = o["version"] as? String, isRunnerVersion(version) else {
        throw ProtocolError("version must be a runner version like 2.330.0")
    }
    guard let b = o["bytes"] as? NSNumber, isInteger(b), (1...maxRunnerBytes).contains(b.intValue) else {
        throw ProtocolError("bytes must be 1 to \(maxRunnerBytes)")
    }
    guard let sha = o["sha256"] as? String, sha.utf8.count == 64, sha.utf8.allSatisfy(isLowerHex) else {
        throw ProtocolError("sha256 must be 64 lowercase hex")
    }
    return RunnerUpload(version: version, bytes: b.intValue, sha256: sha)
}

public func parseJob(_ o: [String: Any]) throws -> JobSpec {
    guard let version = o["runnerVersion"] as? String, isRunnerVersion(version) else {
        throw ProtocolError("runnerVersion must be a runner version like 2.330.0")
    }
    guard let files = o["files"] as? [String: Any], Set(files.keys) == jobFileNames else {
        throw ProtocolError("files must be exactly \(jobFileNames.sorted().joined(separator: ", "))")
    }
    var checkedFiles: [String: String] = [:]
    for (name, value) in files {
        guard let text = value as? String, text.utf8.count <= maxJobFileBytes, !text.utf8.contains(0) else {
            throw ProtocolError("\(name) must be text of at most \(maxJobFileBytes) bytes")
        }
        checkedFiles[name] = text
    }
    guard let env = o["env"] as? [String: Any] else {
        throw ProtocolError("env must be an object")
    }
    var checkedEnv: [String: String] = [:]
    for (name, value) in env {
        guard jobEnvNameAllowed(name) else {
            throw ProtocolError("env \(quoted(name)) is not one a job may set")
        }
        guard let text = value as? String, text.utf8.count <= 4096, !text.utf8.contains(0), !text.contains("\n") else {
            throw ProtocolError("env \(name) must be one line of at most 4096 bytes")
        }
        checkedEnv[name] = text
    }
    guard let args = o["args"] as? [String], allowedRunnerArgs.contains(args) else {
        throw ProtocolError("args must be one of \(allowedRunnerArgs)")
    }
    return JobSpec(runnerVersion: version, files: checkedFiles, env: checkedEnv, args: args)
}

public func parseSignal(_ o: [String: Any]) throws -> JobSignal {
    guard let name = o["signal"] as? String, let signal = JobSignal(rawValue: name) else {
        throw ProtocolError("signal must be TERM, INT or KILL")
    }
    return signal
}

/// The environment the runner gets: the job's allowed names, then the
/// agent's own, which no job can replace.
public func runnerEnvironment(_ spec: JobSpec, home: String) -> [String: String] {
    var env = spec.env
    env["HOME"] = home
    env["USER"] = jobUser
    env["LOGNAME"] = jobUser
    env["SHELL"] = "/bin/zsh"
    env["PATH"] = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    env["TMPDIR"] = home + "/tmp"
    return env
}
