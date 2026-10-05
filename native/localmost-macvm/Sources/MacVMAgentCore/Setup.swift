// The golden image's one-time setup inside the guest, run as root by the
// bootstrap over SSH (`localmost-macvm-agent setup`), as a plan of steps so
// that what it does can be read and tested on the host:
//
//   the job user, an ordinary account, logged in automatically
//   no sleep, and no Setup Assistant at the job user's first login
//   the runner, root's, under /usr/local/localmost/runner/<version>
//   the Xcode Command Line Tools, from softwareupdate
//   the agent, root's, as a LaunchDaemon
//   the marker that says the setup finished
//   the administrator's password replaced by one nobody keeps
//   Remote Login off, then the guest shuts down
//
// Every path it writes is root's and not writable by the job user, so the
// job cannot replace the agent, the runner or the daemon's plist.

import Foundation
import MacVMCore

public let agentInstallDir = "/usr/local/libexec/localmost"
public let agentInstallPath = agentInstallDir + "/localmost-macvm-agent"
public let agentLabel = "com.localmost.macvm.agent"
public let agentPlistPath = "/Library/LaunchDaemons/\(agentLabel).plist"
public let setupMarker = "/var/db/localmost/setup-done"
public let jobUserHome = "/Users/" + jobUser

public enum SetupStep: Equatable {
    /// Runs a program; a non-zero exit fails the setup.
    case run(what: String, argv: [String])
    /// Runs a program as the job user.
    case runAsJobUser(what: String, argv: [String])
    /// Writes a file, owned by root:wheel, with a mode.
    case write(what: String, path: String, contents: Data, mode: Int)
    /// Extracts the runner tar.gz into its version's directory, root's.
    case installRunner(version: String, tarball: String)
    /// Finds the newest Command Line Tools softwareupdate offers and installs it.
    case installCommandLineTools
    /// Copies this agent binary into place, root's, mode 0755.
    case installAgent(from: String)
}

public struct SetupInputs: Equatable {
    public var adminUser: String
    public var adminPassword: String
    /// The job user's password: random, made by Electron, kept nowhere but
    /// /etc/kcpassword, which auto-login needs and only root can read.
    public var jobPassword: String
    /// The password the administrator is given at the end; nobody keeps it.
    public var discardedAdminPassword: String
    public var runnerVersion: String
    public var runnerTarball: String
    public var agentBinary: String
    public var osVersion: String
    public var osBuild: String
}

/// The steps, in order.
public func setupPlan(_ i: SetupInputs) -> [SetupStep] {
    let defaultsPlist = "com.apple.SetupAssistant"
    var steps: [SetupStep] = [
        .run(what: "create the job user \(jobUser), not an administrator",
             argv: ["/usr/sbin/sysadminctl", "-addUser", jobUser, "-fullName", "localmost jobs", "-password", i.jobPassword,
                    "-home", jobUserHome, "-shell", "/bin/zsh"]),
        .run(what: "make the job user's home", argv: ["/usr/sbin/createhomedir", "-c", "-u", jobUser]),
        .write(what: "store the job user's password for auto-login", path: "/etc/kcpassword",
               contents: kcpassword(i.jobPassword), mode: 0o600),
        .run(what: "log the job user in automatically",
             argv: ["/usr/bin/defaults", "write", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser", jobUser]),
        .run(what: "never sleep", argv: ["/usr/bin/pmset", "-a", "sleep", "0", "displaysleep", "0", "disksleep", "0"]),
    ]
    for key in ["DidSeeCloudSetup", "DidSeePrivacy", "DidSeeSiriSetup", "DidSeeScreenTime", "DidSeeAppearanceSetup",
                "DidSeeAccessibility", "DidSeeTouchIDSetup", "DidSeeActivationLock", "SkipFirstLoginOptimization"] {
        steps.append(.runAsJobUser(what: "skip \(key) at the job user's first login",
                                   argv: ["/usr/bin/defaults", "write", defaultsPlist, key, "-bool", "true"]))
    }
    steps += [
        .runAsJobUser(what: "mark this macOS as seen", argv: ["/usr/bin/defaults", "write", defaultsPlist, "LastSeenCloudProductVersion", i.osVersion]),
        .runAsJobUser(what: "mark this build as seen", argv: ["/usr/bin/defaults", "write", defaultsPlist, "LastSeenBuddyBuildVersion", i.osBuild]),
        .installRunner(version: i.runnerVersion, tarball: i.runnerTarball),
        .installCommandLineTools,
        .installAgent(from: i.agentBinary),
        .write(what: "the agent's LaunchDaemon", path: agentPlistPath, contents: agentLaunchDaemonPlist(), mode: 0o644),
        .run(what: "start the agent", argv: ["/bin/launchctl", "bootstrap", "system", agentPlistPath]),
        .write(what: "the setup's marker", path: setupMarker,
               contents: Data("agent \(agentVersion)\nrunner \(i.runnerVersion)\n".utf8), mode: 0o644),
        .run(what: "replace the administrator's password with one nobody keeps",
             argv: ["/usr/sbin/sysadminctl", "-resetPasswordFor", i.adminUser, "-newPassword", i.discardedAdminPassword,
                    "-adminUser", i.adminUser, "-adminPassword", i.adminPassword]),
        .run(what: "keep Remote Login off from the next boot", argv: ["/bin/launchctl", "disable", "system/com.openssh.sshd"]),
    ]
    return steps
}

/// The obfuscation /etc/kcpassword uses: the password XORed with a fixed
/// key, padded with the key to a multiple of 12 bytes. It hides nothing from
/// root; only root can read the file.
public func kcpassword(_ password: String) -> Data {
    let key: [UInt8] = [0x7D, 0x89, 0x52, 0x23, 0xD2, 0xBC, 0xDD, 0xEA, 0xA3, 0xB9, 0x1F]
    var bytes = Array(password.utf8)
    bytes.append(0)
    let padded = ((bytes.count + 11) / 12) * 12
    while bytes.count < padded { bytes.append(0) }
    return Data(bytes.enumerated().map { $0.element ^ key[$0.offset % key.count] })
}

/// The agent's LaunchDaemon: root, always running, restarted when it exits.
public func agentLaunchDaemonPlist() -> Data {
    let plist: [String: Any] = [
        "Label": agentLabel,
        "ProgramArguments": [agentInstallPath, "serve"],
        "RunAtLoad": true,
        "KeepAlive": true,
        "UserName": "root",
        "StandardErrorPath": "/var/log/localmost-macvm-agent.log",
        "StandardOutPath": "/var/log/localmost-macvm-agent.log",
    ]
    // swiftlint-free: a property list of plain values always serializes.
    return (try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)) ?? Data()
}

/// The label of the newest Command Line Tools in `softwareupdate -l`'s
/// output, or nil when it offers none. Lines look like
/// `* Label: Command Line Tools for Xcode 26.4-26.4`.
public func newestCommandLineToolsLabel(_ output: String) -> String? {
    let labels = output.split(separator: "\n").compactMap { line -> String? in
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let range = trimmed.range(of: "Label: ") else { return nil }
        let label = String(trimmed[range.upperBound...])
        return label.hasPrefix("Command Line Tools for Xcode") ? label : nil
    }
    return labels.max { versionKey($0).lexicographicallyPrecedes(versionKey($1)) }
}

/// The numbers in a label, for ordering: `... Xcode 26.4-26.4` -> [26, 4, 26, 4].
private func versionKey(_ label: String) -> [Int] {
    label.split { !$0.isNumber }.compactMap { Int($0) }
}

/// The setup's inputs, as the bootstrap sends them on stdin: one JSON object
/// whose every field is checked. The passwords travel this way, never on a
/// command line of the bootstrap's, which every process in the guest could read.
public func parseSetupInputs(_ data: Data) throws -> SetupInputs {
    guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        throw ProtocolError("the setup's input is not a JSON object")
    }
    func string(_ key: String, _ ok: (String) -> Bool, _ what: String) throws -> String {
        guard let s = o[key] as? String, ok(s) else { throw ProtocolError("\(key) must be \(what)") }
        return s
    }
    let password: (String) -> Bool = { s in
        (16...128).contains(s.count) && s.unicodeScalars.allSatisfy { $0.value > 0x20 && $0.value < 0x7f }
    }
    let absolute: (String) -> Bool = { s in s.hasPrefix("/") && !s.split(separator: "/").contains("..") }
    let printable: (String) -> Bool = { s in
        !s.isEmpty && s.count <= 32 && s.unicodeScalars.allSatisfy { $0.value > 0x20 && $0.value < 0x7f }
    }
    return SetupInputs(
        adminUser: try string("adminUser", isAccountName, "a short account name"),
        adminPassword: try string("adminPassword", password, "16-128 printable ASCII characters"),
        jobPassword: try string("jobPassword", password, "16-128 printable ASCII characters"),
        discardedAdminPassword: try string("discardedAdminPassword", password, "16-128 printable ASCII characters"),
        runnerVersion: try string("runnerVersion", isRunnerVersion, "a runner version like 2.330.0"),
        runnerTarball: try string("runnerTarball", absolute, "an absolute path"),
        agentBinary: try string("agentBinary", absolute, "an absolute path"),
        osVersion: try string("osVersion", printable, "the guest's macOS version"),
        osBuild: try string("osBuild", printable, "the guest's macOS build")
    )
}
