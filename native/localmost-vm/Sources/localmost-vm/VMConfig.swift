// The VM the helper builds (contract §2.2): a Linux boot of the guest image,
// the erofs root read-only on vda, the data disk on vdb, in job mode exactly
// one share (the sandbox's `_work`, tag `work`) plus Rosetta when it is
// installed, one vsock device, entropy, a console, and nothing else. In
// particular no network device: the guest reaches the outside only through
// the vsock relay to the worker's proxy.

import Foundation
import Virtualization

/// What to build, from checked paths only.
struct VMSpec {
    var mode: Mode
    var guest: GuestArtifacts
    var dataDisk: String
    /// The share's real path (job mode), from validateShare.
    var share: String?
    var cpus: Int
    var memoryMiB: Int
}

func kernelCommandLine(_ mode: Mode) -> String {
    "console=hvc0 rdinit=/init ro quiet panic=-1 ipv6.disable=1 lm.mode=\(mode.name)"
}

/// Builds the configuration; `validate()` is left to the caller, since it
/// needs the virtualization entitlement. `rosetta` is the Rosetta share
/// device when the plan says to share it.
func makeConfiguration(_ spec: VMSpec, console: FileHandle, rosetta: VZDirectorySharingDeviceConfiguration?) throws -> VZVirtualMachineConfiguration {
    let c = VZVirtualMachineConfiguration()

    let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: spec.guest.kernel))
    boot.initialRamdiskURL = URL(fileURLWithPath: spec.guest.initramfs)
    boot.commandLine = kernelCommandLine(spec.mode)
    c.bootLoader = boot
    c.cpuCount = spec.cpus
    c.memorySize = UInt64(spec.memoryMiB) << 20

    let root: VZDiskImageStorageDeviceAttachment
    do {
        root = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: spec.guest.rootfs), readOnly: true,
                                                      cachingMode: .automatic, synchronizationMode: .full)
    } catch {
        throw HelperError(.guestImage, "rootfs.erofs cannot be attached: \(describe(error))")
    }
    let data: VZDiskImageStorageDeviceAttachment
    do {
        // A job's disk is thrown away with the VM, so nothing is synced; a
        // refresh's disk becomes the golden disk, so it is.
        let sync: VZDiskImageSynchronizationMode
        switch spec.mode {
        case .job: sync = .none
        case .refresh: sync = .fsync
        }
        data = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: spec.dataDisk), readOnly: false,
                                                      cachingMode: .automatic, synchronizationMode: sync)
    } catch {
        throw HelperError(.disk, "the data disk cannot be attached: \(describe(error))")
    }
    c.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: root), VZVirtioBlockDeviceConfiguration(attachment: data)]

    var shares: [VZDirectorySharingDeviceConfiguration] = []
    if case .job = spec.mode, let share = spec.share {
        let work = VZVirtioFileSystemDeviceConfiguration(tag: "work")
        work.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: share, isDirectory: true), readOnly: false))
        shares.append(work)
        if let rosetta = rosetta {
            shares.append(rosetta)
        }
    }
    c.directorySharingDevices = shares

    c.networkDevices = []
    c.socketDevices = [VZVirtioSocketDeviceConfiguration()]
    c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
    serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: console)
    c.serialPorts = [serial]
    return c
}

/// Whether Rosetta for Linux is on this Mac, as VZ reports it.
enum RosettaAvailability {
    case installed
    case notInstalled
    case notSupported
}

/// What to do about Rosetta, and the `started.rosetta` value that says so.
struct RosettaPlan: Equatable {
    var share: Bool
    var report: String
}

/// Shares Rosetta only when asked (`auto`), in a job VM, and installed. It
/// never installs it: `installRosetta` would prompt the user.
func rosettaPlan(_ mode: RosettaMode, job: Bool, _ availability: () -> RosettaAvailability) -> RosettaPlan {
    guard mode == .auto, job else {
        return RosettaPlan(share: false, report: "off")
    }
    switch availability() {
    case .installed: return RosettaPlan(share: true, report: "installed")
    case .notInstalled: return RosettaPlan(share: false, report: "notInstalled")
    case .notSupported: return RosettaPlan(share: false, report: "notSupported")
    }
}

func vzRosettaAvailability() -> RosettaAvailability {
    switch VZLinuxRosettaDirectoryShare.availability {
    case .installed: return .installed
    case .notInstalled: return .notInstalled
    case .notSupported: return .notSupported
    @unknown default: return .notSupported
    }
}

/// The Rosetta share device, tag `rosetta`.
func rosettaDevice() throws -> VZVirtioFileSystemDeviceConfiguration {
    let device = VZVirtioFileSystemDeviceConfiguration(tag: "rosetta")
    do {
        device.share = try VZLinuxRosettaDirectoryShare()
    } catch {
        throw HelperError(.vzConfig, "the Rosetta share cannot be made: \(describe(error))")
    }
    return device
}
