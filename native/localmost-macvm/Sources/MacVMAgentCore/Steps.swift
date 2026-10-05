// A `localmost test` run in the guest, instead of a runner job: the host's
// copy of the checkout sent in once as a tar, any action a step uses sent
// the same way, then one workflow step at a time, each started as the job
// user, its output streamed back and its exit carrying what it wrote to
// GITHUB_OUTPUT. The CLI drives the run (src/cli/test-vm.ts); the VM is
// thrown away after it, as after a job.
//
//   Electron: {"id":5,"op":"put","dest":"workspace","bytes":n,"sha256":"<hex>"}  then n raw bytes of a tar
//   Electron: {"id":6,"op":"put","dest":"actions/<16 hex>","bytes":n,"sha256":"<hex>"}  then n raw bytes
//   Electron: {"id":7,"op":"step","program":"bash","script":"...","cwd":"workspace/sub","env":{...}}
//   agent:    {"event":"output",...} ... {"event":"exit","code":0,"signal":null,"outputs":"name=value\n"}
//   Electron: {"id":8,"op":"signal","signal":"KILL"}   every step process group this run started
//
// Every path in a command is relative to testRoot and checked here; the
// files are written, and the steps run, as the job user.

import Foundation
import MacVMCore

/// Where a test run's files live: the job user's, made by the job user.
public let testRoot = jobUserHome + "/work"

/// Where the agent keeps a step's script and its GITHUB_OUTPUT file, and an
/// upload on its way to the job user: root's, so the job user can use the
/// files the agent hands it but never put a link where the agent writes.
public let stepScratchDir = "/var/db/localmost/run"

/// The most one upload may be: the same bound as a runner's.
public let maxPutBytes = maxRunnerBytes

/// The most a step's script may be, so that a step command fits one line.
public let maxStepScriptBytes = 32 << 10

/// The most of a step's GITHUB_OUTPUT file sent back with its exit.
public let maxStepOutputsBytes = 16 << 10

/// The most names a step's environment may carry, and the most one value may be.
public let maxStepEnvNames = 512
public let maxStepEnvValueBytes = 16 << 10

/// The programs a step may run: a shell with its script, or the runner's
/// own node with an action's entry point.
public enum StepProgram: String {
    case bash, sh, zsh, node
}

public struct PutSpec: Equatable {
    public var dest: String
    public var bytes: Int
    public var sha256: String
}

public struct StepSpec: Equatable {
    public var program: StepProgram
    /// A shell's script.
    public var script: String?
    /// Node's entry point, relative to testRoot.
    public var entry: String?
    /// Where the step starts, relative to testRoot: the workspace or under it.
    public var cwd: String
    public var env: [String: String]
}

/// `workspace`, or `actions/` and 16 lowercase hex: where an upload goes.
public func isPutDest(_ s: String) -> Bool {
    if s == "workspace" { return true }
    guard s.hasPrefix("actions/") else { return false }
    let id = s.utf8.dropFirst("actions/".utf8.count)
    return id.count == 16 && id.allSatisfy(isLowerHex)
}

/// A path relative to testRoot inside one of its uploads: `workspace` or an
/// action's directory, then names that are neither empty, `.` nor `..`.
public func isTestPath(_ s: String, under roots: [String]) -> Bool {
    guard s.utf8.count <= 1024, !s.utf8.contains(0) else { return false }
    let parts = s.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return false }
    return roots.contains { root in s == root || s.hasPrefix(root + "/") }
}

/// A file in the workspace or in an action's upload: node's entry point.
public func isEntryPath(_ s: String) -> Bool {
    let parts = s.split(separator: "/", omittingEmptySubsequences: false)
    guard isTestPath(s, under: ["workspace", "actions"]), parts.count >= 2 else { return false }
    return parts[0] == "workspace" || (parts.count >= 3 && isPutDest(parts[0] + "/" + parts[1]))
}

/// Whether a step may be given `name`: what a runner job may be given
/// (jobEnvNameAllowed), and the GITHUB_* and RUNNER_* variables a step
/// reads, which no runner sets here. Nothing that changes how the loader,
/// the shell or the agent's own exec chain starts.
public func stepEnvNameAllowed(_ name: String) -> Bool {
    if jobEnvNameAllowed(name) { return true }
    guard name.hasPrefix("GITHUB_") || name.hasPrefix("RUNNER_") else { return false }
    return name.utf8.count <= 128 && name.utf8.allSatisfy { b in
        (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39) || b == 0x5F
    }
}

public func parsePut(_ o: [String: Any]) throws -> PutSpec {
    guard let dest = o["dest"] as? String, isPutDest(dest) else {
        throw ProtocolError("dest must be workspace or actions/<16 hex>")
    }
    guard let b = o["bytes"] as? NSNumber, isInteger(b), (1...maxPutBytes).contains(b.intValue) else {
        throw ProtocolError("bytes must be 1 to \(maxPutBytes)")
    }
    guard let sha = o["sha256"] as? String, sha.utf8.count == 64, sha.utf8.allSatisfy(isLowerHex) else {
        throw ProtocolError("sha256 must be 64 lowercase hex")
    }
    return PutSpec(dest: dest, bytes: b.intValue, sha256: sha)
}

public func parseStep(_ o: [String: Any]) throws -> StepSpec {
    guard let name = o["program"] as? String, let program = StepProgram(rawValue: name) else {
        throw ProtocolError("program must be bash, sh, zsh or node")
    }
    var script: String?
    var entry: String?
    if program == .node {
        guard o["script"] == nil, let e = o["entry"] as? String, isEntryPath(e) else {
            throw ProtocolError("node takes an entry under workspace or actions, and no script")
        }
        entry = e
    } else {
        guard o["entry"] == nil, let s = o["script"] as? String, s.utf8.count <= maxStepScriptBytes, !s.utf8.contains(0) else {
            throw ProtocolError("a shell takes a script of at most \(maxStepScriptBytes) bytes, and no entry")
        }
        script = s
    }
    guard let cwd = o["cwd"] as? String, isTestPath(cwd, under: ["workspace"]) else {
        throw ProtocolError("cwd must be the workspace or a directory under it")
    }
    guard let env = o["env"] as? [String: Any], env.count <= maxStepEnvNames else {
        throw ProtocolError("env must be an object of at most \(maxStepEnvNames) names")
    }
    var checkedEnv: [String: String] = [:]
    for (name, value) in env {
        guard stepEnvNameAllowed(name) else {
            throw ProtocolError("env \(quoted(name)) is not one a step may set")
        }
        guard let text = value as? String, text.utf8.count <= maxStepEnvValueBytes, !text.utf8.contains(0) else {
            throw ProtocolError("env \(name) must be text of at most \(maxStepEnvValueBytes) bytes")
        }
        checkedEnv[name] = text
    }
    return StepSpec(program: program, script: script, entry: entry, cwd: cwd, env: checkedEnv)
}

/// The environment a step gets: what the CLI built for it, then the
/// agent's own values, which no step can replace - the job user's home,
/// path and temp, and the GITHUB_OUTPUT file the agent reads back.
public func stepEnvironment(_ spec: StepSpec, home: String, outputs: String) -> [String: String] {
    var env = spec.env
    for (name, value) in runnerEnvironment(JobSpec(runnerVersion: "", files: [:], env: [:], args: []), home: home) {
        env[name] = value
    }
    env["GITHUB_OUTPUT"] = outputs
    return env
}

/// The program a step runs, as an absolute path: a shell of the guest's,
/// or the newest node of the newest installed runner (`nodes` lists each
/// runner's externals, `node20`, `node24`).
public func stepProgramPath(_ program: StepProgram, runners: [String], nodes: (String) -> [String]) -> String? {
    switch program {
    case .bash: return "/bin/bash"
    case .sh: return "/bin/sh"
    case .zsh: return "/bin/zsh"
    case .node:
        func numbers(_ v: String) -> [Int] { v.split(separator: ".").compactMap { Int($0) } }
        guard let runner = runners.filter(isRunnerVersion).max(by: { numbers($0).lexicographicallyPrecedes(numbers($1)) }) else {
            return nil
        }
        guard let node = nodes(runner).filter({ nodeMajor($0) != nil }).max(by: { nodeMajor($0)! < nodeMajor($1)! }) else {
            return nil
        }
        return "\(runnerRoot)/\(runner)/externals/\(node)/bin/node"
    }
}

/// What a signal to a test run's steps reaches: each step's process group
/// (`groups` maps its leader's pid to whether that leader has exited), less
/// one whose leader exited and whose pid names a live process again - the
/// group emptied, and the pid is someone else's now - and, for a KILL, every
/// process of the job user too, as for a job: a step's strays that left its
/// process group.
public func stepSignalTargets(_ groups: [Int32: Bool], signal: JobSignal, alive: (Int32) -> Bool) -> (groups: [Int32], allOfJobUser: Bool) {
    let pgids = groups.keys.sorted().filter { pid in !(groups[pid]! && alive(pid)) }
    return (pgids, signal == .KILL)
}

/// Whether `path` is a node stepProgramPath could have chosen.
public func isRunnerNode(_ path: String) -> Bool {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    let root = runnerRoot.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == root.count + 5, Array(parts.prefix(root.count)) == root else { return false }
    let rest = Array(parts.dropFirst(root.count))
    return isRunnerVersion(rest[0]) && rest[1] == "externals" && nodeMajor(rest[2]) != nil && rest[3] == "bin" && rest[4] == "node"
}

/// `node20` as 20: a runner's externals directory for one node, or nil.
func nodeMajor(_ name: String) -> Int? {
    let digits = name.utf8.dropFirst(4)
    guard name.hasPrefix("node"), (1...3).contains(digits.count), digits.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return nil }
    return Int(String(decoding: digits, as: UTF8.self))
}
