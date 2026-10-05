// Runs the setup plan (MacVMAgentCore.setupPlan) as root, reporting each step
// on stdout for the bootstrap to pass on, and ends by turning Remote Login
// off and shutting the guest down - after the last line has gone out over
// the SSH session that runs it.

import Darwin
import Foundation
import MacVMAgentCore
import MacVMCore

func runSetup(_ inputs: SetupInputs) -> Int32 {
    let steps = setupPlan(inputs)
    for (index, step) in steps.enumerated() {
        emit(["event": "step", "index": index + 1, "of": steps.count, "what": summary(step)])
        do {
            try perform(step)
        } catch {
            emit(["event": "failed", "index": index + 1, "message": bounded(describe(error))])
            return 1
        }
    }
    emit(["event": "done"])
    // Detached, so that the SSH session can end first: then sshd stops, and
    // the guest powers off, which ends the provisioning helper.
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", "sleep 3; /bin/launchctl bootout system/com.openssh.sshd; /sbin/shutdown -h now"]
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run()
    return 0
}

private func summary(_ step: SetupStep) -> String {
    switch step {
    case .run(let what, _), .runAsJobUser(let what, _), .write(let what, _, _, _): return what
    case .installRunner(let version, _): return "install runner \(version)"
    case .installCommandLineTools: return "install the Xcode Command Line Tools"
    case .installAgent: return "install the agent"
    }
}

private let rootOwned: [FileAttributeKey: Any] = [.ownerAccountID: 0, .groupOwnerAccountID: 0]

private func perform(_ step: SetupStep) throws {
    switch step {
    case .run(_, let argv):
        try runChecked(argv)
    case .runAsJobUser(_, let argv):
        try runChecked(["/usr/bin/sudo", "-u", jobUser, "-H"] + argv)
    case .write(_, let path, let contents, let mode):
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                attributes: rootOwned.merging([.posixPermissions: 0o755]) { $1 })
        try? FileManager.default.removeItem(atPath: path)
        guard FileManager.default.createFile(atPath: path, contents: contents,
                                             attributes: rootOwned.merging([.posixPermissions: mode]) { $1 })
        else {
            throw ProtocolError("\(path) cannot be written")
        }
    case .installRunner(let version, let tarball):
        let dest = "\(runnerRoot)/\(version)"
        try? FileManager.default.removeItem(atPath: dest)
        try FileManager.default.createDirectory(atPath: dest, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        try runChecked(["/usr/bin/tar", "-xzf", tarball, "-C", dest])
        try runChecked(["/usr/sbin/chown", "-R", "root:wheel", runnerRoot])
        try runChecked(["/bin/chmod", "-R", "go-w", runnerRoot])
    case .installCommandLineTools:
        // softwareupdate offers the Command Line Tools only while this
        // marker exists, as xcode-select --install arranges it.
        let marker = "/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress"
        FileManager.default.createFile(atPath: marker, contents: Data())
        defer { try? FileManager.default.removeItem(atPath: marker) }
        let list = try runChecked(["/usr/sbin/softwareupdate", "-l"])
        guard let label = newestCommandLineToolsLabel(list) else {
            throw ProtocolError("softwareupdate offers no Command Line Tools")
        }
        try runChecked(["/usr/sbin/softwareupdate", "-i", label, "--verbose"])
    case .installAgent(let from):
        try FileManager.default.createDirectory(atPath: agentInstallDir, withIntermediateDirectories: true,
                                                attributes: rootOwned.merging([.posixPermissions: 0o755]) { $1 })
        try? FileManager.default.removeItem(atPath: agentInstallPath)
        try FileManager.default.copyItem(atPath: from, toPath: agentInstallPath)
        try FileManager.default.setAttributes(rootOwned.merging([.posixPermissions: 0o755]) { $1 }, ofItemAtPath: agentInstallPath)
    }
}
