import Virtualization
import XCTest
@testable import localmost_vm

/// The VM the helper builds (contract §2.2), checked on the configuration
/// itself: unit tests cannot boot a VM (no CI runner has nested
/// virtualization), and building the configuration needs no entitlement.
final class VMConfigTests: XCTestCase {
    private var tmp: TempDir!
    private var guest: GuestArtifacts!
    private var console: Pipe!

    override func setUpWithError() throws {
        tmp = try TempDir()
        guest = GuestArtifacts(kernel: try tmp.write("guest/vmlinux", 64), initramfs: try tmp.write("guest/initramfs.cpio.gz", 64),
                               rootfs: try tmp.write("guest/rootfs.erofs", 4096))
        try tmp.write("vm/data.img", 1 << 20)
        try tmp.mkdir("share")
        console = Pipe()
    }

    override func tearDown() {
        tmp = nil
    }

    private func spec(_ mode: Mode) -> VMSpec {
        VMSpec(mode: mode, guest: guest, dataDisk: tmp.sub("vm/data.img"),
               share: mode == .refresh(repoKey: "0123456789abcdef") ? nil : tmp.sub("share"), cpus: 3, memoryMiB: 2048)
    }

    private let job = Mode.job(sandboxId: "3-a1b2c3d4e5f6", proxyPort: 1)
    private let refresh = Mode.refresh(repoKey: "0123456789abcdef")

    func testTheKernelCommandLineIsExactlyTheContracts() {
        XCTAssertEqual(kernelCommandLine(job), "console=hvc0 rdinit=/init ro quiet panic=-1 ipv6.disable=1 lm.mode=job")
        XCTAssertEqual(kernelCommandLine(refresh), "console=hvc0 rdinit=/init ro quiet panic=-1 ipv6.disable=1 lm.mode=refresh")
    }

    func testAJobVm() throws {
        let c = try makeConfiguration(spec(job), console: console.fileHandleForWriting, rosetta: nil)

        let boot = try XCTUnwrap(c.bootLoader as? VZLinuxBootLoader)
        XCTAssertEqual(boot.kernelURL.path, guest.kernel)
        XCTAssertEqual(boot.initialRamdiskURL?.path, guest.initramfs)
        XCTAssertEqual(boot.commandLine, kernelCommandLine(job))
        XCTAssertEqual(c.cpuCount, 3)
        XCTAssertEqual(c.memorySize, 2048 << 20)

        XCTAssertEqual(c.storageDevices.count, 2)
        let root = try XCTUnwrap((c.storageDevices[0] as? VZVirtioBlockDeviceConfiguration)?.attachment as? VZDiskImageStorageDeviceAttachment)
        XCTAssertEqual(root.url.path, guest.rootfs, "vda is the root")
        XCTAssertTrue(root.isReadOnly)
        XCTAssertEqual(root.synchronizationMode, .full)
        let data = try XCTUnwrap((c.storageDevices[1] as? VZVirtioBlockDeviceConfiguration)?.attachment as? VZDiskImageStorageDeviceAttachment)
        XCTAssertEqual(data.url.path, tmp.sub("vm/data.img"), "vdb is the data disk")
        XCTAssertFalse(data.isReadOnly)
        XCTAssertEqual(data.cachingMode, .automatic)
        XCTAssertEqual(data.synchronizationMode, .none, "a job's disk is thrown away")

        XCTAssertEqual(c.directorySharingDevices.count, 1, "exactly one share")
        let fs = try XCTUnwrap(c.directorySharingDevices[0] as? VZVirtioFileSystemDeviceConfiguration)
        XCTAssertEqual(fs.tag, "work")
        let share = try XCTUnwrap(fs.share as? VZSingleDirectoryShare)
        XCTAssertEqual(share.directory.url.path, tmp.sub("share"))
        XCTAssertFalse(share.directory.isReadOnly)

        XCTAssertTrue(c.networkDevices.isEmpty, "no network: the relay is the only way out")
        XCTAssertEqual(c.socketDevices.count, 1)
        XCTAssertTrue(c.socketDevices[0] is VZVirtioSocketDeviceConfiguration)
        XCTAssertEqual(c.entropyDevices.count, 1)
        XCTAssertEqual(c.serialPorts.count, 1)
        XCTAssertTrue(c.serialPorts[0] is VZVirtioConsoleDeviceSerialPortConfiguration)
        XCTAssertTrue(c.memoryBalloonDevices.isEmpty)
        XCTAssertTrue(c.graphicsDevices.isEmpty)
        XCTAssertTrue(c.audioDevices.isEmpty)
        XCTAssertTrue(c.keyboards.isEmpty)
        XCTAssertTrue(c.pointingDevices.isEmpty)
        XCTAssertTrue(c.consoleDevices.isEmpty)
        if #available(macOS 15, *) {
            XCTAssertTrue(c.usbControllers.isEmpty)
        }
    }

    func testARefreshVmHasNoShareAndAnFsyncedDisk() throws {
        let c = try makeConfiguration(spec(refresh), console: console.fileHandleForWriting, rosetta: nil)
        XCTAssertTrue(c.directorySharingDevices.isEmpty)
        XCTAssertEqual((c.bootLoader as? VZLinuxBootLoader)?.commandLine, kernelCommandLine(refresh))
        let data = try XCTUnwrap((c.storageDevices[1] as? VZVirtioBlockDeviceConfiguration)?.attachment as? VZDiskImageStorageDeviceAttachment)
        XCTAssertEqual(data.synchronizationMode, .fsync, "the refresh disk becomes the golden disk")
        XCTAssertTrue(c.networkDevices.isEmpty)
    }

    func testRosettaIsASecondShareTaggedRosetta() throws {
        let stand = VZVirtioFileSystemDeviceConfiguration(tag: "rosetta")
        stand.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: tmp.sub("share")), readOnly: true))
        let c = try makeConfiguration(spec(job), console: console.fileHandleForWriting, rosetta: stand)
        XCTAssertEqual(c.directorySharingDevices.compactMap { ($0 as? VZVirtioFileSystemDeviceConfiguration)?.tag }, ["work", "rosetta"])
    }

    func testAMissingDataDiskIsEDisk() throws {
        try FileManager.default.removeItem(atPath: tmp.sub("vm/data.img"))
        XCTAssertThrowsError(try makeConfiguration(spec(job), console: console.fileHandleForWriting, rosetta: nil)) {
            XCTAssertEqual(($0 as? HelperError)?.code, .disk)
        }
    }

    func testAMissingRootIsEGuestImage() throws {
        try FileManager.default.removeItem(atPath: guest.rootfs)
        XCTAssertThrowsError(try makeConfiguration(spec(job), console: console.fileHandleForWriting, rosetta: nil)) {
            XCTAssertEqual(($0 as? HelperError)?.code, .guestImage)
        }
    }

    // MARK: - Rosetta

    func testRosettaIsSharedOnlyWhenAskedInstalledAndAJob() {
        XCTAssertEqual(rosettaPlan(.auto, job: true) { .installed }, RosettaPlan(share: true, report: "installed"))
        XCTAssertEqual(rosettaPlan(.auto, job: true) { .notInstalled }, RosettaPlan(share: false, report: "notInstalled"))
        XCTAssertEqual(rosettaPlan(.auto, job: true) { .notSupported }, RosettaPlan(share: false, report: "notSupported"))
    }

    func testOffAndRefreshNeverAskVz() {
        let never: () -> RosettaAvailability = {
            XCTFail("availability asked")
            return .installed
        }
        XCTAssertEqual(rosettaPlan(.off, job: true, never), RosettaPlan(share: false, report: "off"))
        XCTAssertEqual(rosettaPlan(.auto, job: false, never), RosettaPlan(share: false, report: "off"), "a refresh VM has no Rosetta")
    }
}
