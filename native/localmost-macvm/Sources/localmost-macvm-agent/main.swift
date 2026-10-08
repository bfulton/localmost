// localmost-macvm-agent: the agent inside a localmost macOS VM.
//
//   localmost-macvm-agent serve      the LaunchDaemon: vsock port 1025, from the host only
//   localmost-macvm-agent setup      the golden image's one-time setup, as root over SSH;
//                                    its inputs as one JSON object on stdin
//   localmost-macvm-agent exec-as --user runner --dir <dir> [--env-file <file>] -- <program> [args...]
//                                    root to the job user, then exec (see ExecAs.swift)
//   localmost-macvm-agent kill-all --user runner
//                                    root to the job user, then SIGKILL to all its processes
//   localmost-macvm-agent version
//
// It runs as root. What it accepts is MacVMAgentCore's allowlists; what it
// does to the guest is GuestSystem.

import Darwin
import Foundation
import MacVMAgentCore
import MacVMCore

signal(SIGPIPE, SIG_IGN)

func log(_ message: String) {
    let flat = message.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }.joined()
    writeAll(2, Data("\(ISO8601DateFormatter().string(from: Date())) \(flat)\n".utf8))
}

func emit(_ fields: [String: Any]) {
    if let line = encodeLine(fields) { writeAll(1, line) }
}

let argv = Array(CommandLine.arguments.dropFirst())
switch argv.first {
case "version":
    emit(["agent": agentVersion])
    exit(0)

case "serve":
    let system = GuestSystem(log: log)
    let boot = BootState()
    let listener: Int32
    do {
        listener = try vsockListen(port: AgentPorts.control)
    } catch {
        log("vsock port \(AgentPorts.control) cannot be listened on: \(describe(error))")
        exit(1)
    }
    log("agent \(agentVersion) listening on vsock port \(AgentPorts.control)")
    while true {
        guard let fd = vsockAcceptFromHost(listener) else { continue }
        noSigPipe(fd)
        let session = AgentSession(system: system, boot: boot, send: { writeAll(fd, $0) })
        session.greet()
        Thread {
            var buf = [UInt8](repeating: 0, count: 64 << 10)
            while true {
                let n = read(fd, &buf, buf.count)
                if n < 0, errno == EINTR { continue }
                if n <= 0 { break }
                session.received(Data(buf[0..<n]))
            }
            session.connectionClosed()
            session.drain()
            close(fd)
        }.start()
    }

case "exec-as":
    // Root, in the job user's login session, started with rootSideEnvironment
    // alone: read the program's environment from the agent's env file and
    // remove it, become the job user for good, check that root cannot be had
    // back, then exec the program with that environment and nothing else.
    let spec: ExecAs
    do {
        spec = try parseExecAs(Array(argv.dropFirst()))
    } catch let e as ProtocolError {
        log(e.message)
        exit(64)
    }
    var programEnv = execAsEnvironment([:], home: jobUserHome)
    if let file = spec.envFile {
        do {
            let data = try readEnvFile(file, owner: 0)
            unlink(file)
            programEnv = execAsEnvironment(try parseEnvFile(data), home: jobUserHome)
        } catch let e as ProtocolError {
            log("exec-as cannot use its env file: \(e.message)")
            exit(65)
        }
    }
    guard let pw = getpwnam(spec.user) else {
        log("no user \(spec.user)")
        exit(67)
    }
    let uid = pw.pointee.pw_uid
    let gid = pw.pointee.pw_gid
    guard setsid() >= 0 || getpgrp() == getpid(),
          initgroups(spec.user, Int32(bitPattern: gid)) == 0, setgid(gid) == 0, setuid(uid) == 0,
          getuid() == uid, geteuid() == uid, getgid() == gid, getegid() == gid,
          setuid(0) != 0, seteuid(0) != 0
    else {
        log("exec-as could not become \(spec.user) for good: \(posixMessage())")
        exit(77)
    }
    guard chdir(spec.dir) == 0 else {
        log("exec-as cannot enter \(spec.dir): \(posixMessage())")
        exit(66)
    }
    let cArgs = spec.argv.map { strdup($0) } + [nil]
    let cEnv = programEnv.map { strdup("\($0.key)=\($0.value)") } + [nil]
    execve(spec.argv[0], cArgs, cEnv)
    log("exec-as cannot run \(spec.argv[0]): \(posixMessage())")
    exit(126)

case "kill-all":
    // Root to the job user, then SIGKILL to every process that user has.
    guard argv.count == 3, argv[1] == "--user", argv[2] == jobUser, let pw = getpwnam(jobUser) else {
        log("usage: kill-all --user \(jobUser)")
        exit(64)
    }
    let uid = pw.pointee.pw_uid
    guard setgid(pw.pointee.pw_gid) == 0, setuid(uid) == 0, getuid() == uid, geteuid() == uid, setuid(0) != 0 else {
        log("kill-all could not become \(jobUser): \(posixMessage())")
        exit(77)
    }
    kill(-1, SIGKILL)
    exit(0)

case "setup":
    guard getuid() == 0 else {
        log("setup runs as root")
        exit(77)
    }
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let inputs: SetupInputs
    do {
        inputs = try parseSetupInputs(input)
    } catch let e as ProtocolError {
        emit(["event": "failed", "message": e.message])
        exit(64)
    }
    exit(runSetup(inputs))

default:
    log("usage: localmost-macvm-agent serve | setup | exec-as ... | version")
    exit(64)
}
