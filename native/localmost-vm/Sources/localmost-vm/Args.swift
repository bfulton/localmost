// The helper's command line (contract §2.1), parsed exactly: every flag is
// known, each appears once, the mode-specific ones are required in their
// mode and refused in the other, and every id is checked against its §1
// form before anything is built from it. Nothing on the line is a path a job
// chose: the helper derives the share, the disk and the sockets itself.

/// Whether to share Rosetta with the guest when it is installed.
enum RosettaMode: Equatable {
    case auto
    case off
}

/// What the VM is for, with the flags only that mode takes.
enum Mode: Equatable {
    /// A worker's VM: the share of its sandbox, and the relay to its proxy.
    case job(sandboxId: String, proxyPort: Int)
    /// A refresh of a repository's golden disk: no share, no relay.
    case refresh(repoKey: String)

    var name: String {
        switch self {
        case .job: return "job"
        case .refresh: return "refresh"
        }
    }
}

struct RunArgs: Equatable {
    var vmId: String
    /// The slot in the VM id: 1-99 for a job, 0 for a refresh.
    var slot: Int
    var mode: Mode
    /// `<data>`, not yet realpathed: the helper does that once, in Paths.
    var dataDir: String
    /// `<resources>`, where guest/ is.
    var resources: String
    var cpus: Int
    var memoryMiB: Int
    var rosetta: RosettaMode
}

enum Command: Equatable {
    /// Print the helper and contract versions and exit.
    case version
    /// Run one VM.
    case run(RunArgs)
}

let cpuRange = 1...64
let memoryMiBRange = 1024...65536
let portRange = 1...65535

private let commonFlags: Set<String> = [
    "--vm-id", "--mode", "--data-dir", "--resources", "--cpus", "--memory-mib", "--rosetta",
]
private let jobFlags: Set<String> = ["--sandbox-id", "--proxy-port"]
private let refreshFlags: Set<String> = ["--repo-key"]

/// Parses the arguments after the program name.
func parseCommand(_ argv: [String]) throws -> Command {
    guard let command = argv.first else {
        throw HelperError(.args, "no command: expected run or version")
    }
    switch command {
    case "version":
        guard argv.count == 1 else {
            throw HelperError(.args, "version takes no arguments")
        }
        return .version
    case "run":
        return .run(try parseRun(Array(argv.dropFirst())))
    default:
        throw HelperError(.args, "unknown command \(quoted(command)): expected run or version")
    }
}

private func parseRun(_ argv: [String]) throws -> RunArgs {
    var flags: [String: String] = [:]
    var i = 0
    while i < argv.count {
        let flag = argv[i]
        guard commonFlags.contains(flag) || jobFlags.contains(flag) || refreshFlags.contains(flag) else {
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

    func required(_ flag: String) throws -> String {
        guard let value = flags[flag] else {
            throw HelperError(.args, "\(flag) is required")
        }
        return value
    }

    let modeName = try required("--mode")
    let mode: Mode
    switch modeName {
    case "job":
        for flag in refreshFlags where flags[flag] != nil {
            throw HelperError(.args, "\(flag) is for --mode refresh only")
        }
        let sandboxId = try required("--sandbox-id")
        guard isSlotId(sandboxId) else {
            throw HelperError(.args, "--sandbox-id \(quoted(sandboxId)) is not <slot>-<12 hex>")
        }
        mode = .job(sandboxId: sandboxId, proxyPort: try number(try required("--proxy-port"), "--proxy-port", portRange))
    case "refresh":
        for flag in jobFlags where flags[flag] != nil {
            throw HelperError(.args, "\(flag) is for --mode job only")
        }
        let repoKey = try required("--repo-key")
        guard repoKey.utf8.count == 16, repoKey.utf8.allSatisfy(isLowerHex) else {
            throw HelperError(.args, "--repo-key \(quoted(repoKey)) is not 16 hex")
        }
        mode = .refresh(repoKey: repoKey)
    default:
        throw HelperError(.args, "--mode \(quoted(modeName)) is not job or refresh")
    }

    let vmId = try required("--vm-id")
    guard isSlotId(vmId), let slot = Int(vmId.prefix { $0 != "-" }) else {
        throw HelperError(.args, "--vm-id \(quoted(vmId)) is not <slot>-<12 hex>")
    }
    switch mode {
    case .job where slot == 0:
        throw HelperError(.args, "--vm-id \(vmId): slot 0 is the refresh slot")
    case .refresh where slot != 0:
        throw HelperError(.args, "--vm-id \(vmId): a refresh VM uses slot 0")
    default:
        break
    }

    let rosettaName = try required("--rosetta")
    let rosetta: RosettaMode
    switch rosettaName {
    case "auto": rosetta = .auto
    case "off": rosetta = .off
    default: throw HelperError(.args, "--rosetta \(quoted(rosettaName)) is not auto or off")
    }

    return RunArgs(
        vmId: vmId,
        slot: slot,
        mode: mode,
        dataDir: try absolutePath(try required("--data-dir"), "--data-dir"),
        resources: try absolutePath(try required("--resources"), "--resources"),
        cpus: try number(try required("--cpus"), "--cpus", cpuRange),
        memoryMiB: try number(try required("--memory-mib"), "--memory-mib", memoryMiBRange),
        rosetta: rosetta
    )
}

/// `^(?:0|[1-9][0-9]?)-[0-9a-f]{12}$`, the vm id and sandbox id form (§1),
/// matched by hand so that nothing like a trailing newline slips through.
func isSlotId(_ s: String) -> Bool {
    let parts = s.utf8.split(separator: UInt8(ascii: "-"), maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2 else { return false }
    let slot = parts[0], hex = parts[1]
    guard (1...2).contains(slot.count), slot.allSatisfy(isDigit) else { return false }
    guard slot.count == 1 || slot.first != UInt8(ascii: "0") else { return false }
    return hex.count == 12 && hex.allSatisfy(isLowerHex)
}

private func isDigit(_ c: UInt8) -> Bool {
    c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9")
}

func isLowerHex(_ c: UInt8) -> Bool {
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

private func absolutePath(_ s: String, _ flag: String) throws -> String {
    guard s.hasPrefix("/"), !s.utf8.contains(0) else {
        throw HelperError(.args, "\(flag) \(quoted(s)) is not an absolute path")
    }
    return s
}

/// A value for a message: quoted, with anything unprintable escaped.
func quoted(_ s: String) -> String {
    String(s.prefix(256)).debugDescription
}
