// The VMs the helper builds. Every boot of a golden image or its clone is a
// Mac platform with the image's hardware model, its auxiliary storage, one
// virtio disk, a graphics device (headless unless the guided window shows
// it), a keyboard and a trackpad, entropy, and:
//
//   install, provision   a NAT network device - the installer needs none, but
//                        provisioning does, for Remote Login and for
//                        softwareupdate; the install VM is never booted
//   save-state, job      no network device at all, and one vsock device: the
//                        guest reaches the outside only through the vsock
//                        relays to the job's proxy and broker
//
// save-state and job build the same configuration from the same function,
// since VZ restores a saved state only into a configuration like the one it
// was saved from.

import Foundation
import MacVMCore
import Virtualization

enum Purpose {
    case install
    case provision(macAddress: String)
    case saveState
    case job
}

struct MacSpec {
    var purpose: Purpose
    var hardwareModel: Data
    /// The identifier this boot presents: that of the slot whose lock it holds.
    var machineIdentifier: Data
    var aux: String
    var disk: String
    var cpus: Int
    var memoryBytes: UInt64
}

/// The display every macOS VM has: a laptop-sized panel, so that the guided
/// window fits a laptop screen, and a modest framebuffer.
let displayWidth = 1440
let displayHeight = 900
let displayPPI = 110

func makeConfiguration(_ spec: MacSpec, createAux: Bool = false) throws -> VZVirtualMachineConfiguration {
    guard let model = VZMacHardwareModel(dataRepresentation: spec.hardwareModel) else {
        throw HelperError(.image, "the image's hardware model cannot be read")
    }
    guard model.isSupported else {
        throw HelperError(.unsupported, "this Mac cannot run the image's hardware model")
    }
    guard let identifier = VZMacMachineIdentifier(dataRepresentation: spec.machineIdentifier) else {
        throw HelperError(.image, "the image's machine identifier cannot be read")
    }
    let platform = VZMacPlatformConfiguration()
    platform.hardwareModel = model
    platform.machineIdentifier = identifier
    if createAux {
        do {
            platform.auxiliaryStorage = try VZMacAuxiliaryStorage(creatingStorageAt: URL(fileURLWithPath: spec.aux),
                                                                  hardwareModel: model, options: [])
        } catch {
            throw HelperError(.install, "aux.img cannot be created: \(describe(error))")
        }
    } else {
        platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: URL(fileURLWithPath: spec.aux))
    }

    let c = VZVirtualMachineConfiguration()
    c.platform = platform
    c.bootLoader = VZMacOSBootLoader()
    c.cpuCount = spec.cpus
    c.memorySize = spec.memoryBytes

    let graphics = VZMacGraphicsDeviceConfiguration()
    graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: displayWidth, heightInPixels: displayHeight,
                                                            pixelsPerInch: displayPPI)]
    c.graphicsDevices = [graphics]
    c.keyboards = [VZMacKeyboardConfiguration()]
    c.pointingDevices = [VZMacTrackpadConfiguration()]
    c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

    let sync: VZDiskImageSynchronizationMode
    switch spec.purpose {
    // A job's clone is thrown away with the VM, so nothing is synced.
    case .job: sync = .none
    // A golden disk is what every job starts from: every write reaches it.
    case .install, .provision, .saveState: sync = .full
    }
    let disk: VZDiskImageStorageDeviceAttachment
    do {
        disk = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: spec.disk), readOnly: false,
                                                      cachingMode: .automatic, synchronizationMode: sync)
    } catch {
        throw HelperError(.image, "disk.img cannot be attached: \(describe(error))")
    }
    c.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]

    switch spec.purpose {
    case .install:
        c.networkDevices = []
        c.socketDevices = []
    case .provision(let mac):
        let nic = VZVirtioNetworkDeviceConfiguration()
        nic.attachment = VZNATNetworkDeviceAttachment()
        guard let address = VZMACAddress(string: mac) else {
            throw HelperError(.image, "the image's MAC address \(quoted(mac)) cannot be read")
        }
        nic.macAddress = address
        c.networkDevices = [nic]
        c.socketDevices = []
    case .saveState, .job:
        c.networkDevices = []
        c.socketDevices = [VZVirtioSocketDeviceConfiguration()]
    }
    c.directorySharingDevices = []
    c.serialPorts = []
    c.audioDevices = []
    return c
}

/// Validates a configuration, as an E_VZ_CONFIG failure.
func validate(_ c: VZVirtualMachineConfiguration) throws {
    do {
        try c.validate()
    } catch {
        throw HelperError(.vzConfig, "the VM configuration is not valid: \(describe(error))")
    }
}

/// Why VZ cannot save or restore this configuration, or nil when it can.
func saveRestoreRefusal(_ c: VZVirtualMachineConfiguration) -> String? {
    do {
        try c.validateSaveRestoreSupport()
        return nil
    } catch {
        return describe(error)
    }
}

/// A fresh machine identifier's data.
func newMachineIdentifierData() -> Data {
    VZMacMachineIdentifier().dataRepresentation
}
