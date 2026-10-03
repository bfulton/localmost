// The golden image as files: its config.json, which `install` writes last,
// once macOS is on the disk; the check every command that boots it makes
// first; each slot's saved state and its stamp, which says which host and
// helper the state was saved by and so whether it can be restored here; and
// how a job VM starts from all of that.

import Darwin
import Foundation

/// config.json of a golden image. Written once, by `install`, after the
/// installer succeeded: an image without it was never finished.
public struct ImageConfig: Codable, Equatable {
    public static let schemaVersion = 1

    public var schema: Int
    public var imageId: String
    /// The macOS build installed, as the restore image reported it: `25G83`.
    public var build: String
    /// `26.6.2`.
    public var os: String
    /// VZMacHardwareModel.dataRepresentation, base64.
    public var hardwareModel: String
    /// VZMacMachineIdentifier.dataRepresentation, base64, one per slot:
    /// slot 1's first. Two VMs running at once with one identifier is
    /// undefined behaviour in the guest (VZMacPlatformConfiguration.h), so
    /// the two slots never share one. The install and the provisioning boot
    /// present slot 1's.
    public var machineIdentifiers: [String]
    /// The disk image's length in bytes. It is sparse: the space it uses is
    /// what macOS wrote.
    public var diskBytes: Int64
    /// The provisioning boot's NAT interface, a locally administered unicast
    /// address, so that Electron can find its lease.
    public var macAddress: String
    /// The restore image's minimums, which every boot honours.
    public var minCpus: Int
    public var minMemoryBytes: UInt64

    public init(imageId: String, build: String, os: String, hardwareModel: Data, machineIdentifiers: [Data],
                diskBytes: Int64, macAddress: String, minCpus: Int, minMemoryBytes: UInt64) {
        schema = ImageConfig.schemaVersion
        self.imageId = imageId
        self.build = build
        self.os = os
        self.hardwareModel = hardwareModel.base64EncodedString()
        self.machineIdentifiers = machineIdentifiers.map { $0.base64EncodedString() }
        self.diskBytes = diskBytes
        self.macAddress = macAddress
        self.minCpus = minCpus
        self.minMemoryBytes = minMemoryBytes
    }

    public var hardwareModelData: Data? { Data(base64Encoded: hardwareModel) }

    /// The identity a VM in `slot` presents, or nil for a slot that is not 1 or 2.
    public func machineIdentifierData(slot: Int) -> Data? {
        guard macVMSlots.contains(slot), machineIdentifiers.count == macVMSlots.count else { return nil }
        return Data(base64Encoded: machineIdentifiers[slot - macVMSlots.lowerBound])
    }

    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self) + Data("\n".utf8)
    }

    /// Decodes and checks a config: the schema, the id it must carry, and
    /// every field in its form.
    public static func decode(_ data: Data, imageId: String) throws -> ImageConfig {
        let config: ImageConfig
        do {
            config = try JSONDecoder().decode(ImageConfig.self, from: data)
        } catch {
            throw HelperError(.image, "config.json is not a golden image config: \(error)")
        }
        guard config.schema == schemaVersion else {
            throw HelperError(.image, "config.json is schema \(config.schema), not \(schemaVersion)")
        }
        guard config.imageId == imageId else {
            throw HelperError(.image, "config.json is for image \(quoted(config.imageId)), not \(imageId)")
        }
        guard config.hardwareModelData?.isEmpty == false else {
            throw HelperError(.image, "config.json has no hardware model")
        }
        let identifiers = macVMSlots.compactMap { config.machineIdentifierData(slot: $0) }.filter { !$0.isEmpty }
        guard identifiers.count == macVMSlots.count, Set(identifiers).count == identifiers.count else {
            throw HelperError(.image, "config.json must hold two different machine identifiers, one per slot")
        }
        guard config.diskBytes > 0, isMACAddress(config.macAddress), (1...cpuRange.upperBound).contains(config.minCpus),
              config.minMemoryBytes > 0
        else {
            throw HelperError(.image, "config.json has a field out of its range")
        }
        return config
    }
}

/// Whether `s` is a lowercase `xx:xx:xx:xx:xx:xx` whose first octet is
/// locally administered and unicast, as `newMACAddress` makes them.
public func isMACAddress(_ s: String) -> Bool {
    let parts = s.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 6, parts.allSatisfy({ $0.utf8.count == 2 && $0.utf8.allSatisfy(isLowerHex) }),
          let first = UInt8(parts[0], radix: 16)
    else { return false }
    return first & 0b11 == 0b10
}

/// A random locally administered unicast MAC address.
public func newMACAddress(_ random: () -> [UInt8] = { (0..<6).map { _ in UInt8.random(in: 0...255) } }) -> String {
    var bytes = random()
    bytes[0] = (bytes[0] & 0b1111_1100) | 0b10
    return bytes.map { String(format: "%02x", $0) }.joined(separator: ":")
}

/// The most config.json or state.json may be.
let maxConfigBytes = 64 << 10

/// One slot's saved state: the disk and auxiliary storage it was saved
/// from, cloned from the golden image and booted with the slot's identity,
/// the state itself, and its stamp. The three files go together: the state
/// holds the guest's memory as it was over exactly that disk.
public struct SlotState: Equatable {
    public let dir: String
    public let disk: String
    public let aux: String
    public let state: String
    public let stamp: StateStamp
}

/// A golden image whose files were checked: paths, config, and which slots
/// have a whole saved state.
public struct CheckedImage {
    public let dir: String
    public let config: ImageConfig
    public let disk: String
    public let aux: String
    public let states: [Int: SlotState]

    /// `<image>/slot<n>`, which Electron makes and save-state fills.
    public func slotDir(_ slot: Int) -> String { dir + "/" + slotDirName(slot) }
}

public func slotDirName(_ slot: Int) -> String { "slot\(slot)" }

/// Checks a golden image: config.json reads and is for this id, disk.img
/// and aux.img are regular files (not links) and the disk is the length the
/// config says. A slot's saved state counts only when it is whole.
public func checkImage(_ imageDir: String, imageId: String) throws -> CheckedImage {
    let dir: RealDirectory
    do {
        dir = try RealDirectory(imageDir)
    } catch let e as POSIXError {
        throw HelperError(.image, "the image directory \(imageDir) cannot be opened: \(e.message)")
    }
    defer { dir.close() }
    guard dir.path == imageDir else {
        throw HelperError(.image, "the image directory resolves to \(dir.path), not \(imageDir)")
    }
    let raw: Data
    do {
        raw = try readSmallFile(in: dir.fd, GoldenFile.config, max: maxConfigBytes)
    } catch let e as POSIXError {
        throw HelperError(.image, e.code == .ENOENT
            ? "the image has no config.json: its install never finished"
            : "config.json cannot be read: \(e.message)")
    }
    let config = try ImageConfig.decode(raw, imageId: imageId)
    switch entry(in: dir.fd, GoldenFile.disk) {
    case .regular(let size) where size == config.diskBytes:
        break
    case .regular(let size):
        throw HelperError(.image, "disk.img is \(size) bytes; config.json says \(config.diskBytes)")
    case .missing:
        throw HelperError(.image, "disk.img is missing")
    case .other:
        throw HelperError(.image, "disk.img is a link or not a regular file")
    }
    switch entry(in: dir.fd, GoldenFile.aux) {
    case .regular(let size) where size > 0:
        break
    case .missing:
        throw HelperError(.image, "aux.img is missing")
    default:
        throw HelperError(.image, "aux.img is empty, a link or not a regular file")
    }
    var states: [Int: SlotState] = [:]
    for slot in macVMSlots {
        if let state = slotState(imageDir, slot: slot, diskBytes: config.diskBytes) {
            states[slot] = state
        }
    }
    return CheckedImage(dir: imageDir, config: config, disk: imageDir + "/" + GoldenFile.disk,
                        aux: imageDir + "/" + GoldenFile.aux, states: states)
}

/// A slot's saved state when it is whole: the slot's own directory, not a
/// link; its disk a regular file of the golden length; its aux storage and
/// state regular files; and a stamp that reads and names this slot.
func slotState(_ imageDir: String, slot: Int, diskBytes: Int64) -> SlotState? {
    let path = imageDir + "/" + slotDirName(slot)
    guard let dir = try? RealDirectory(path) else { return nil }
    defer { dir.close() }
    guard dir.path == path,
          case .regular(let size) = entry(in: dir.fd, SlotFile.disk), size == diskBytes,
          case .regular(let auxSize) = entry(in: dir.fd, SlotFile.aux), auxSize > 0,
          case .regular = entry(in: dir.fd, SlotFile.state),
          let data = try? readSmallFile(in: dir.fd, SlotFile.stateStamp, max: maxConfigBytes),
          let stamp = try? JSONDecoder().decode(StateStamp.self, from: data), stamp.slot == slot
    else { return nil }
    return SlotState(dir: path, disk: path + "/" + SlotFile.disk, aux: path + "/" + SlotFile.aux,
                     state: path + "/" + SlotFile.state, stamp: stamp)
}

/// state.json beside a slot's saved state: the slot, what saved it, and the
/// shape of the VM it was saved from. VZ restores a state only into a
/// configuration like the one it was saved from, and a host update can make
/// it refuse one anyway, so a state is offered for restore only when all of
/// this still holds.
public struct StateStamp: Codable, Equatable {
    public var slot: Int
    /// The host's macOS build when the state was saved (`kern.osversion`).
    public var hostBuild: String
    public var helperVersion: String
    public var cpus: Int
    public var memoryMiB: Int

    public init(slot: Int, hostBuild: String, helperVersion: String, cpus: Int, memoryMiB: Int) {
        self.slot = slot
        self.hostBuild = hostBuild
        self.helperVersion = helperVersion
        self.cpus = cpus
        self.memoryMiB = memoryMiB
    }
}

/// Why a saved state cannot be restored for this run, or nil when it can.
public func restoreRefusal(_ stamp: StateStamp, hostBuild: String, helperVersion: String, cpus: Int, memoryMiB: Int) -> String? {
    if stamp.hostBuild != hostBuild {
        return "it was saved on macOS build \(stamp.hostBuild), and this Mac now runs \(hostBuild)"
    }
    if stamp.helperVersion != helperVersion {
        return "it was saved by helper \(stamp.helperVersion), not \(helperVersion)"
    }
    if stamp.cpus != cpus || stamp.memoryMiB != memoryMiB {
        return "it was saved with \(stamp.cpus) CPUs and \(stamp.memoryMiB) MiB, not \(cpus) and \(memoryMiB)"
    }
    return nil
}

/// How a job VM starts: which directory's disk.img and aux.img it clones,
/// whether it restores a state over them, and the identity it presents.
public struct JobStart: Equatable {
    /// The golden image's directory, or its slot's when the slot's state is
    /// restored: a state goes only with the disk it was saved from.
    public let sourceDir: String
    public let plan: StartPlan
    public let machineIdentifier: Data
    /// Why the run boots cold although it asked to restore.
    public let restoreSkipped: String?
}

/// The start of a job VM in `slot`: its slot's saved state and disk when
/// asked to restore and the state still fits this host and shape; otherwise
/// the golden disk, cold. Either way with the slot's own identity.
public func jobStart(_ image: CheckedImage, slot: Int, boot: BootMode, hostBuild: String, helperVersion: String,
                     cpus: Int, memoryMiB: Int) -> JobStart {
    let identifier = image.config.machineIdentifierData(slot: slot) ?? Data()
    let cold = { (why: String?) in
        JobStart(sourceDir: image.dir, plan: .cold, machineIdentifier: identifier, restoreSkipped: why)
    }
    guard boot == .restore else { return cold(nil) }
    guard let state = image.states[slot] else { return cold("slot \(slot) has no saved state") }
    if let why = restoreRefusal(state.stamp, hostBuild: hostBuild, helperVersion: helperVersion, cpus: cpus, memoryMiB: memoryMiB) {
        return cold(why)
    }
    return JobStart(sourceDir: state.dir, plan: .restore(state.state), machineIdentifier: identifier, restoreSkipped: nil)
}

/// The host's macOS build, `kern.osversion`: `25G83`.
public func hostOSBuild() -> String {
    var size = 0
    guard sysctlbyname("kern.osversion", nil, &size, nil, 0) == 0, size > 0 else { return "" }
    var buf = [CChar](repeating: 0, count: size)
    guard sysctlbyname("kern.osversion", &buf, &size, nil, 0) == 0 else { return "" }
    return String(cString: buf)
}
