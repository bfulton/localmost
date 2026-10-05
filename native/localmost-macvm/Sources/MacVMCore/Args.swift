// The helper's command line, parsed exactly: every flag is known to its
// command, each appears once, every required one is there, and every id and
// number is checked against its form before anything is built from it.
// Nothing on the line is a path a job chose: the helper derives every file
// of an image or a VM from `--data-dir` and the ids, and the one other path,
// the restore image Electron downloaded, must be in `<data>/macos-vm/ipsw`.

/// How a job VM starts.
public enum BootMode: String, Equatable {
    /// From the golden image's saved state, falling back to a cold boot when
    /// VZ refuses it.
    case restore
    /// A cold boot, never touching the saved state.
    case cold
}

/// How the provisioning boot is driven.
public enum Display: String, Equatable {
    /// Headless, with VZMacGuestProvisioningOptions (macOS 27 and later).
    case none
    /// A window showing the VM, for the guided setup on older hosts.
    case window
}

public struct InstallArgs: Equatable {
    public var dataDir: String
    public var imageId: String
    public var ipsw: String
    public var diskGiB: Int
    public var slot: Int
}

public struct ProvisionArgs: Equatable {
    public var dataDir: String
    public var imageId: String
    public var slot: Int
    public var display: Display
}

public struct SaveStateArgs: Equatable {
    public var dataDir: String
    public var imageId: String
    public var slot: Int
    public var cpus: Int
    public var memoryMiB: Int
}

public struct RunArgs: Equatable {
    public var dataDir: String
    public var imageId: String
    public var vmId: String
    /// The slot in the VM id: 1 or 2.
    public var slot: Int
    public var proxyPort: Int
    public var brokerPort: Int
    public var cpus: Int
    public var memoryMiB: Int
    public var boot: BootMode
}

public struct CheckArgs: Equatable {
    public var dataDir: String
    public var imageId: String
}

public enum Command: Equatable {
    /// Print the helper's version, its contract and what it was built with.
    case version
    /// Ask VZ for the latest restore image this Mac supports.
    case catalog
    /// Read a downloaded restore image's version and requirements.
    case inspect(ipsw: String)
    /// Install macOS from a restore image into a new golden image.
    case install(InstallArgs)
    /// Boot the golden image for its one-time setup.
    case provision(ProvisionArgs)
    /// Boot the golden image as a job would, wait for its agent, and save its state.
    case saveState(SaveStateArgs)
    /// Run one job's VM from a clone of the golden image.
    case run(RunArgs)
    /// Check the golden image's files and whether this Mac can run it.
    case check(CheckArgs)
}

/// The two macOS VMs a Mac may run at once (macOS licence, and VZ's own limit).
public let macVMSlots = 1...2
public let cpuRange = 2...32
public let memoryMiBRange = 4096...65536
public let diskGiBRange = 40...512
public let portRange = 1...65535

private let commandFlags: [String: (required: Set<String>, optional: Set<String>)] = [
    "inspect": (["--ipsw"], []),
    "install": (["--data-dir", "--image-id", "--ipsw", "--disk-gib", "--slot"], []),
    "provision": (["--data-dir", "--image-id", "--slot", "--display"], []),
    "save-state": (["--data-dir", "--image-id", "--slot", "--cpus", "--memory-mib"], []),
    "run": (["--data-dir", "--image-id", "--vm-id", "--proxy-port", "--broker-port", "--cpus", "--memory-mib", "--boot"], []),
    "check": (["--data-dir", "--image-id"], []),
]

/// Parses the arguments after the program name.
public func parseCommand(_ argv: [String]) throws -> Command {
    guard let command = argv.first else {
        throw HelperError(.args, "no command: expected one of \(knownCommands)")
    }
    let rest = Array(argv.dropFirst())
    switch command {
    case "version", "catalog":
        guard rest.isEmpty else {
            throw HelperError(.args, "\(command) takes no arguments")
        }
        return command == "version" ? .version : .catalog
    default:
        break
    }
    guard let spec = commandFlags[command] else {
        throw HelperError(.args, "unknown command \(quoted(command)): expected one of \(knownCommands)")
    }
    let flags = try parseFlags(rest, allowed: spec.required.union(spec.optional))
    for flag in spec.required.sorted() where flags[flag] == nil {
        throw HelperError(.args, "\(command): \(flag) is required")
    }
    func value(_ flag: String) -> String { flags[flag]! }

    switch command {
    case "inspect":
        return .inspect(ipsw: try absolutePath(value("--ipsw"), "--ipsw"))
    case "install":
        let dataDir = try absolutePath(value("--data-dir"), "--data-dir")
        let ipsw = try absolutePath(value("--ipsw"), "--ipsw")
        guard isIpswPath(ipsw, dataDir: dataDir) else {
            throw HelperError(.args, "--ipsw \(quoted(ipsw)) is not <data-dir>/macos-vm/ipsw/<name>.ipsw")
        }
        return .install(InstallArgs(
            dataDir: dataDir,
            imageId: try imageId(value("--image-id")),
            ipsw: ipsw,
            diskGiB: try number(value("--disk-gib"), "--disk-gib", diskGiBRange),
            slot: try number(value("--slot"), "--slot", macVMSlots)
        ))
    case "provision":
        guard let display = Display(rawValue: value("--display")) else {
            throw HelperError(.args, "--display \(quoted(value("--display"))) is not none or window")
        }
        return .provision(ProvisionArgs(
            dataDir: try absolutePath(value("--data-dir"), "--data-dir"),
            imageId: try imageId(value("--image-id")),
            slot: try number(value("--slot"), "--slot", macVMSlots),
            display: display
        ))
    case "save-state":
        return .saveState(SaveStateArgs(
            dataDir: try absolutePath(value("--data-dir"), "--data-dir"),
            imageId: try imageId(value("--image-id")),
            slot: try number(value("--slot"), "--slot", macVMSlots),
            cpus: try number(value("--cpus"), "--cpus", cpuRange),
            memoryMiB: try number(value("--memory-mib"), "--memory-mib", memoryMiBRange)
        ))
    case "run":
        let vmId = value("--vm-id")
        guard isVMId(vmId), let slot = Int(vmId.prefix { $0 != "-" }) else {
            throw HelperError(.args, "--vm-id \(quoted(vmId)) is not <1|2>-<12 hex>")
        }
        guard let boot = BootMode(rawValue: value("--boot")) else {
            throw HelperError(.args, "--boot \(quoted(value("--boot"))) is not restore or cold")
        }
        let proxyPort = try number(value("--proxy-port"), "--proxy-port", portRange)
        let brokerPort = try number(value("--broker-port"), "--broker-port", portRange)
        guard proxyPort != brokerPort else {
            throw HelperError(.args, "--proxy-port and --broker-port are both \(proxyPort)")
        }
        return .run(RunArgs(
            dataDir: try absolutePath(value("--data-dir"), "--data-dir"),
            imageId: try imageId(value("--image-id")),
            vmId: vmId,
            slot: slot,
            proxyPort: proxyPort,
            brokerPort: brokerPort,
            cpus: try number(value("--cpus"), "--cpus", cpuRange),
            memoryMiB: try number(value("--memory-mib"), "--memory-mib", memoryMiBRange),
            boot: boot
        ))
    case "check":
        return .check(CheckArgs(
            dataDir: try absolutePath(value("--data-dir"), "--data-dir"),
            imageId: try imageId(value("--image-id"))
        ))
    default:
        throw HelperError(.args, "unknown command \(quoted(command))")
    }
}

private let knownCommands = "version, catalog, inspect, install, provision, save-state, run or check"

private func parseFlags(_ argv: [String], allowed: Set<String>) throws -> [String: String] {
    var flags: [String: String] = [:]
    var i = 0
    while i < argv.count {
        let flag = argv[i]
        guard allowed.contains(flag) else {
            throw HelperError(.args, "unknown argument \(quoted(flag))")
        }
        guard i + 1 < argv.count else {
            throw HelperError(.args, "\(flag) needs a value")
        }
        guard flags[flag] == nil else {
            throw HelperError(.args, "\(flag) given twice")
        }
        flags[flag] = argv[i + 1]
        i += 2
    }
    return flags
}

/// An image id: 12 lowercase hex, as Electron makes them.
public func isImageId(_ s: String) -> Bool {
    s.utf8.count == 12 && s.utf8.allSatisfy(isLowerHex)
}

private func imageId(_ s: String) throws -> String {
    guard isImageId(s) else {
        throw HelperError(.args, "--image-id \(quoted(s)) is not 12 hex")
    }
    return s
}

/// `^[12]-[0-9a-f]{12}$`, a job VM's id: its slot, and 12 hex of its own,
/// matched by hand so that nothing like a trailing newline slips through.
public func isVMId(_ s: String) -> Bool {
    let bytes = Array(s.utf8)
    guard bytes.count == 14, bytes[0] == UInt8(ascii: "1") || bytes[0] == UInt8(ascii: "2"), bytes[1] == UInt8(ascii: "-") else {
        return false
    }
    return bytes[2...].allSatisfy(isLowerHex)
}

/// Whether `path` is a plain `<dataDir>/macos-vm/ipsw/<name>.ipsw`, with a
/// name of letters, digits, `.`, `_` and `-` that does not start with a dot.
public func isIpswPath(_ path: String, dataDir: String) -> Bool {
    let prefix = dataDir + "/macos-vm/ipsw/"
    guard path.hasPrefix(prefix) else { return false }
    let name = path.dropFirst(prefix.count)
    guard name.hasSuffix(".ipsw"), name.count > 5, name.first != "." else { return false }
    return name.utf8.allSatisfy { c in
        (c >= UInt8(ascii: "a") && c <= UInt8(ascii: "z")) || (c >= UInt8(ascii: "A") && c <= UInt8(ascii: "Z"))
            || isDigit(c) || c == UInt8(ascii: ".") || c == UInt8(ascii: "_") || c == UInt8(ascii: "-")
    }
}

func isDigit(_ c: UInt8) -> Bool {
    c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9")
}

public func isLowerHex(_ c: UInt8) -> Bool {
    isDigit(c) || (c >= UInt8(ascii: "a") && c <= UInt8(ascii: "f"))
}

/// A decimal in range, written as a number is: digits only, no sign, no
/// leading zero.
private func number(_ s: String, _ flag: String, _ range: ClosedRange<Int>) throws -> Int {
    let bytes = Array(s.utf8)
    guard !bytes.isEmpty, bytes.count <= 6, bytes.allSatisfy(isDigit), bytes.count == 1 || bytes[0] != UInt8(ascii: "0"),
          let n = Int(s), range.contains(n)
    else {
        throw HelperError(.args, "\(flag) \(quoted(s)) is not a number from \(range.lowerBound) to \(range.upperBound)")
    }
    return n
}

/// An absolute path with no NUL, no `.` or `..` component and no doubled or
/// trailing slash: the helper derives paths by appending to it, so it must
/// already be in the one form Electron passes.
private func absolutePath(_ s: String, _ flag: String) throws -> String {
    let parts = s.split(separator: "/", omittingEmptySubsequences: false)
    guard s.hasPrefix("/"), s.count > 1, !s.utf8.contains(0), !s.hasSuffix("/"),
          !parts.dropFirst().contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })
    else {
        throw HelperError(.args, "\(flag) \(quoted(s)) is not a plain absolute path")
    }
    return s
}

/// A value for a message: quoted, with anything unprintable escaped.
public func quoted(_ s: String) -> String {
    String(s.prefix(256)).debugDescription
}
