import XCTest
@testable import MacVMCore

/// The golden image's files, its config, and its saved state's stamp.
final class ImageTests: XCTestCase {
    private var tmp: TempDir!

    override func setUpWithError() throws {
        tmp = try TempDir()
    }

    override func tearDown() {
        tmp = nil
    }

    private func imageError(_ body: () throws -> Void, _ match: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            guard let e = error as? HelperError else { return XCTFail("\(error)", file: file, line: line) }
            XCTAssertEqual(e.code, .image, file: file, line: line)
            XCTAssertTrue(e.message.contains(match), "\(e.message) does not mention \(match)", file: file, line: line)
        }
    }

    func testAFinishedImageChecks() throws {
        let dir = try makeImage(tmp)
        let real = tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6"
        XCTAssertEqual(dir, tmp.path + "/data/macos-vm/images/a1b2c3d4e5f6")
        let image = try checkImage(real, imageId: "a1b2c3d4e5f6")
        XCTAssertEqual(image.config.build, "25G83")
        XCTAssertEqual(image.disk, real + "/disk.img")
        XCTAssertTrue(image.states.isEmpty)
    }

    func testThePathMustBeTheRealOne() throws {
        try makeImage(tmp)
        // tmp.path runs through /var, a link: the check wants the real path.
        imageError({ _ = try checkImage(tmp.path + "/data/macos-vm/images/a1b2c3d4e5f6", imageId: "a1b2c3d4e5f6") }, "resolves to")
    }

    func testAnImageWithoutItsConfigWasNeverFinished() throws {
        try makeImage(tmp)
        try FileManager.default.removeItem(atPath: tmp.sub("data/macos-vm/images/a1b2c3d4e5f6/config.json"))
        imageError({ _ = try checkImage(tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6", imageId: "a1b2c3d4e5f6") },
                   "install never finished")
    }

    func testTheConfigMustBeForThisImage() throws {
        try makeImage(tmp)
        imageError({ _ = try checkImage(tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6", imageId: "ffffffffffff") }, "not ffffffffffff")
    }

    func testTheDiskMustBeARegularFileOfTheConfiguredLength() throws {
        try makeImage(tmp)
        let real = tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6"
        let fh = FileHandle(forWritingAtPath: real + "/disk.img")!
        try fh.truncate(atOffset: 4096)
        try fh.close()
        imageError({ _ = try checkImage(real, imageId: "a1b2c3d4e5f6") }, "config.json says")

        try FileManager.default.removeItem(atPath: real + "/disk.img")
        try tmp.write("elsewhere.img", Data(count: 1 << 20))
        try FileManager.default.createSymbolicLink(atPath: real + "/disk.img", withDestinationPath: tmp.real + "/elsewhere.img")
        imageError({ _ = try checkImage(real, imageId: "a1b2c3d4e5f6") }, "link")
    }

    func testAuxStorageMustBeThere() throws {
        try makeImage(tmp)
        let real = tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6"
        try FileManager.default.removeItem(atPath: real + "/aux.img")
        imageError({ _ = try checkImage(real, imageId: "a1b2c3d4e5f6") }, "aux.img is missing")
    }

    func testEachSlotsSavedStateCountsOnlyWhenWhole() throws {
        try makeImage(tmp, states: [1, 2])
        let real = tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6"
        let both = try checkImage(real, imageId: "a1b2c3d4e5f6")
        XCTAssertEqual(both.states.keys.sorted(), [1, 2])
        XCTAssertEqual(both.states[2]?.dir, real + "/slot2")
        XCTAssertEqual(both.states[2]?.disk, real + "/slot2/disk.img")
        XCTAssertEqual(both.states[2]?.aux, real + "/slot2/aux.img")
        XCTAssertEqual(both.states[2]?.state, real + "/slot2/state.vzvmsave")
        XCTAssertEqual(both.states[2]?.stamp.cpus, 4)

        // No stamp, no state.
        try FileManager.default.removeItem(atPath: real + "/slot2/state.json")
        XCTAssertEqual(try checkImage(real, imageId: "a1b2c3d4e5f6").states.keys.sorted(), [1])

        // A stamp for the other slot: its state was taken with the other identity.
        try JSONEncoder().encode(StateStamp(slot: 2, hostBuild: "25G83", helperVersion: "1.0.0", cpus: 4, memoryMiB: 6144))
            .write(to: URL(fileURLWithPath: real + "/slot1/state.json"))
        XCTAssertTrue(try checkImage(real, imageId: "a1b2c3d4e5f6").states.isEmpty)
    }

    func testASlotStateNeedsItsOwnDiskOfTheGoldenLength() throws {
        try makeImage(tmp, states: [1])
        let real = tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6"
        let fh = FileHandle(forWritingAtPath: real + "/slot1/disk.img")!
        try fh.truncate(atOffset: 4096)
        try fh.close()
        XCTAssertTrue(try checkImage(real, imageId: "a1b2c3d4e5f6").states.isEmpty)

        // A link at the slot's disk, even to a disk of the right length, is not its disk.
        try FileManager.default.removeItem(atPath: real + "/slot1/disk.img")
        try makeSparse(tmp.real + "/elsewhere.img", bytes: 1 << 20)
        try FileManager.default.createSymbolicLink(atPath: real + "/slot1/disk.img", withDestinationPath: tmp.real + "/elsewhere.img")
        XCTAssertTrue(try checkImage(real, imageId: "a1b2c3d4e5f6").states.isEmpty)

        // Nor is a slot directory that is a link to another image's whole slot.
        try FileManager.default.removeItem(atPath: real + "/slot1")
        try makeImage(tmp, id: "ffffffffffff", states: [1])
        try FileManager.default.createSymbolicLink(atPath: real + "/slot1",
                                                   withDestinationPath: tmp.real + "/data/macos-vm/images/ffffffffffff/slot1")
        XCTAssertTrue(try checkImage(real, imageId: "a1b2c3d4e5f6").states.isEmpty)
    }

    func testConfigRoundTripsAndRefusesBadFields() throws {
        let config = ImageConfig(imageId: "a1b2c3d4e5f6", build: "25G83", os: "26.6.2", hardwareModel: Data([1]),
                                 machineIdentifiers: [Data([2]), Data([3])], diskBytes: 10, macAddress: "02:00:00:00:00:01",
                                 minCpus: 2, minMemoryBytes: 1)
        XCTAssertEqual(try ImageConfig.decode(try config.encoded(), imageId: "a1b2c3d4e5f6"), config)
        var bad = config
        bad.macAddress = "01:00:00:00:00:01"
        imageError({ _ = try ImageConfig.decode(try bad.encoded(), imageId: "a1b2c3d4e5f6") }, "out of its range")
        bad = config
        bad.schema = 2
        imageError({ _ = try ImageConfig.decode(try bad.encoded(), imageId: "a1b2c3d4e5f6") }, "schema 2")
        bad = config
        bad.hardwareModel = ""
        imageError({ _ = try ImageConfig.decode(try bad.encoded(), imageId: "a1b2c3d4e5f6") }, "hardware model")
        bad = config
        bad.machineIdentifiers = [config.machineIdentifiers[0]]
        imageError({ _ = try ImageConfig.decode(try bad.encoded(), imageId: "a1b2c3d4e5f6") }, "two different machine identifiers")
        bad = config
        bad.machineIdentifiers = [config.machineIdentifiers[0], config.machineIdentifiers[0]]
        imageError({ _ = try ImageConfig.decode(try bad.encoded(), imageId: "a1b2c3d4e5f6") }, "two different machine identifiers")
        imageError({ _ = try ImageConfig.decode(Data("[]".utf8), imageId: "a1b2c3d4e5f6") }, "not a golden image config")
    }

    func testMACAddressesAreLocallyAdministeredUnicast() {
        for _ in 0..<64 {
            XCTAssertTrue(isMACAddress(newMACAddress()))
        }
        XCTAssertEqual(newMACAddress { [0xff, 0, 0, 0, 0, 1] }, "fe:00:00:00:00:01")
        XCTAssertFalse(isMACAddress("FE:00:00:00:00:01"))
        XCTAssertFalse(isMACAddress("00:00:00:00:00:01"), "universally administered")
        XCTAssertFalse(isMACAddress("03:00:00:00:00:01"), "multicast")
        XCTAssertFalse(isMACAddress("02:00:00:00:00"))
    }

    func testAStateRestoresOnlyWhereItWasSaved() {
        let stamp = StateStamp(slot: 1, hostBuild: "25G83", helperVersion: "1.0.0", cpus: 4, memoryMiB: 6144)
        XCTAssertNil(restoreRefusal(stamp, hostBuild: "25G83", helperVersion: "1.0.0", cpus: 4, memoryMiB: 6144))
        XCTAssertNotNil(restoreRefusal(stamp, hostBuild: "25H12", helperVersion: "1.0.0", cpus: 4, memoryMiB: 6144))
        XCTAssertNotNil(restoreRefusal(stamp, hostBuild: "25G83", helperVersion: "1.0.1", cpus: 4, memoryMiB: 6144))
        XCTAssertNotNil(restoreRefusal(stamp, hostBuild: "25G83", helperVersion: "1.0.0", cpus: 6, memoryMiB: 6144))
        XCTAssertNotNil(restoreRefusal(stamp, hostBuild: "25G83", helperVersion: "1.0.0", cpus: 4, memoryMiB: 8192))
    }

    func testAJobRestoresItsSlotsStateOrBootsTheGoldenDiskCold() throws {
        try makeImage(tmp, states: [1])
        let real = tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6"
        let image = try checkImage(real, imageId: "a1b2c3d4e5f6")
        func start(_ slot: Int, _ boot: BootMode, host: String = "25G83", cpus: Int = 4) -> JobStart {
            jobStart(image, slot: slot, boot: boot, hostBuild: host, helperVersion: "1.0.0", cpus: cpus, memoryMiB: 6144)
        }

        // Its own slot's disk and state, together: the state was saved from that disk.
        let restored = start(1, .restore)
        XCTAssertEqual(restored.sourceDir, real + "/slot1")
        XCTAssertEqual(restored.plan, .restore(real + "/slot1/state.vzvmsave"))
        XCTAssertNil(restored.restoreSkipped)
        XCTAssertEqual(restored.machineIdentifier, Data([4, 5, 6]))

        // Slot 2 has no state: the golden disk, cold, with slot 2's identity.
        let cold = start(2, .restore)
        XCTAssertEqual(cold.sourceDir, real)
        XCTAssertEqual(cold.plan, .cold)
        XCTAssertEqual(cold.restoreSkipped, "slot 2 has no saved state")
        XCTAssertEqual(cold.machineIdentifier, Data([7, 8, 9]))

        // A state saved elsewhere or in another shape is not used, and says why.
        XCTAssertEqual(start(1, .restore, host: "25H12").plan, .cold)
        XCTAssertEqual(start(1, .restore, host: "25H12").sourceDir, real)
        XCTAssertNotNil(start(1, .restore, host: "25H12").restoreSkipped)
        XCTAssertNotNil(start(1, .restore, cpus: 6).restoreSkipped)

        // Asked for cold: the golden disk, and nothing to explain.
        XCTAssertEqual(start(1, .cold).sourceDir, real)
        XCTAssertEqual(start(1, .cold).plan, .cold)
        XCTAssertNil(start(1, .cold).restoreSkipped)
    }

    func testHostBuildIsRead() {
        XCTAssertFalse(hostOSBuild().isEmpty)
    }

    func testAtomicWritesReplaceButNeverFollow() throws {
        try tmp.mkdir("d")
        let dir = try RealDirectory(tmp.sub("d"))
        defer { dir.close() }
        try writeFileAtomically(in: dir.fd, "f", Data("one".utf8))
        try writeFileAtomically(in: dir.fd, "f", Data("two".utf8))
        XCTAssertEqual(try String(contentsOfFile: tmp.sub("d/f")), "two")
        // A link at the name is replaced by the file, not written through.
        try tmp.write("target", Data("keep".utf8))
        try tmp.symlink("d/g", to: tmp.sub("target"))
        try writeFileAtomically(in: dir.fd, "g", Data("new".utf8))
        XCTAssertEqual(try String(contentsOfFile: tmp.sub("target")), "keep")
        XCTAssertEqual(try String(contentsOfFile: tmp.sub("d/g")), "new")
    }
}

/// Clones of the golden files, and the two slots.
final class CloneTests: XCTestCase {
    private var tmp: TempDir!

    override func setUpWithError() throws {
        tmp = try TempDir()
    }

    override func tearDown() {
        tmp = nil
    }

    func testCloneMakesBothFilesInTheVMDirectory() throws {
        try makeImage(tmp)
        let image = try checkImage(tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6", imageId: "a1b2c3d4e5f6")
        try tmp.mkdir("data/macos-vm/vms/1-0123456789ab")
        let vm = tmp.real + "/data/macos-vm/vms/1-0123456789ab"
        let clone = try cloneGolden(image, into: vm)
        XCTAssertEqual(clone.disk, vm + "/disk.img")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: vm).sorted(), ["aux.img", "disk.img"])
        XCTAssertEqual(FileManager.default.contents(atPath: clone.aux), FileManager.default.contents(atPath: image.aux))

        // A write to the clone never reaches the golden file.
        try Data("job".utf8).write(to: URL(fileURLWithPath: clone.aux))
        XCTAssertEqual(FileManager.default.contents(atPath: image.aux), Data(repeating: 7, count: 4096))

        removeClone(in: vm)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: vm), [])
    }

    func testARestoringJobClonesItsSlotsDisksNotTheGoldenOnes() throws {
        try makeImage(tmp, states: [2])
        let real = tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6"
        try Data("slot two".utf8).write(to: URL(fileURLWithPath: real + "/slot2/aux.img"))
        let image = try checkImage(real, imageId: "a1b2c3d4e5f6")
        try tmp.mkdir("data/macos-vm/vms/2-0123456789ab")
        let vm = tmp.real + "/data/macos-vm/vms/2-0123456789ab"
        let start = jobStart(image, slot: 2, boot: .restore, hostBuild: "25G83", helperVersion: "1.0.0", cpus: 4, memoryMiB: 6144)
        let clone = try cloneDisks(from: start.sourceDir, diskBytes: image.config.diskBytes, into: vm)
        XCTAssertEqual(FileManager.default.contents(atPath: clone.aux), Data("slot two".utf8))
    }

    func testCloneRefusesALinkedVMDirectoryAndNeverReplaces() throws {
        try makeImage(tmp)
        let image = try checkImage(tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6", imageId: "a1b2c3d4e5f6")
        try tmp.mkdir("elsewhere")
        try tmp.mkdir("data/macos-vm/vms")
        try tmp.symlink("data/macos-vm/vms/1-0123456789ab", to: tmp.real + "/elsewhere")
        XCTAssertThrowsError(try cloneGolden(image, into: tmp.real + "/data/macos-vm/vms/1-0123456789ab")) {
            XCTAssertEqual(($0 as? HelperError)?.code, .clone)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tmp.sub("elsewhere")), [])

        try tmp.mkdir("data/macos-vm/vms/2-0123456789ab")
        let vm = tmp.real + "/data/macos-vm/vms/2-0123456789ab"
        try tmp.write("data/macos-vm/vms/2-0123456789ab/aux.img", Data("mine".utf8))
        XCTAssertThrowsError(try cloneGolden(image, into: vm)) { XCTAssertEqual(($0 as? HelperError)?.code, .clone) }
        // The disk it cloned before the clash is gone; what was there stays.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: vm), ["aux.img"])
        XCTAssertEqual(FileManager.default.contents(atPath: vm + "/aux.img"), Data("mine".utf8))
    }

    func testASlotIsHeldByOneHelperAtATime() throws {
        try tmp.mkdir("data/macos-vm/slots")
        let layout = Layout(realDataDir: tmp.real + "/data")
        let one = try SlotLock(layout: layout, slot: 1)
        XCTAssertThrowsError(try SlotLock(layout: layout, slot: 1)) { error in
            XCTAssertEqual((error as? HelperError)?.code, .slot)
            XCTAssertTrue((error as? HelperError)?.message.contains("in use") == true)
        }
        let two = try SlotLock(layout: layout, slot: 2)
        XCTAssertThrowsError(try SlotLock(layout: layout, slot: 3)) { XCTAssertEqual(($0 as? HelperError)?.code, .slot) }
        one.release()
        XCTAssertNoThrow(try SlotLock(layout: layout, slot: 1))
        two.release()
    }

    func testASlotHeldByAnotherProcessIsRefused() throws {
        try tmp.mkdir("data/macos-vm/slots")
        let lock = tmp.real + "/data/macos-vm/slots/1.lock"
        // flock(1) is not on macOS; a child holding the lock through perl's flock is.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
        p.arguments = ["-e", "use Fcntl ':flock'; open(my $f, '>>', $ARGV[0]) or die; flock($f, LOCK_EX) or die; print \"held\\n\"; $| = 1; sleep 30;", lock]
        let out = Pipe()
        p.standardOutput = out
        try p.run()
        defer { p.terminate(); p.waitUntilExit() }
        let line = out.fileHandleForReading.availableData
        XCTAssertEqual(String(decoding: line, as: UTF8.self), "held\n")
        XCTAssertThrowsError(try SlotLock(layout: Layout(realDataDir: tmp.real + "/data"), slot: 1)) {
            XCTAssertEqual(($0 as? HelperError)?.code, .slot)
        }
    }

    func testTheSlotsDirectoryMustNotBeALink() throws {
        try tmp.mkdir("elsewhere")
        try tmp.mkdir("data/macos-vm")
        try tmp.symlink("data/macos-vm/slots", to: tmp.real + "/elsewhere")
        XCTAssertThrowsError(try SlotLock(layout: Layout(realDataDir: tmp.real + "/data"), slot: 1)) {
            XCTAssertEqual(($0 as? HelperError)?.code, .slot)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tmp.sub("elsewhere")), [])
    }

    func testLayoutResolvesTheRealDataDirectoryAndRefusesLinks() throws {
        try tmp.mkdir("data/macos-vm/images/a1b2c3d4e5f6")
        let (layout, dir) = try Layout.forImage(dataDir: tmp.path + "/data", imageId: "a1b2c3d4e5f6")
        XCTAssertEqual(layout.dataDir, tmp.real + "/data")
        XCTAssertEqual(dir, tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6")

        try tmp.mkdir("other/vm")
        try tmp.mkdir("data/macos-vm/vms")
        try tmp.symlink("data/macos-vm/vms/1-0123456789ab", to: tmp.real + "/other/vm")
        XCTAssertThrowsError(try Layout.forVM(dataDir: tmp.path + "/data", vmId: "1-0123456789ab")) {
            XCTAssertEqual(($0 as? HelperError)?.code, .args)
        }
        XCTAssertThrowsError(try Layout.forVM(dataDir: tmp.path + "/data", vmId: "2-0123456789ab")) {
            XCTAssertEqual(($0 as? HelperError)?.code, .args)
        }
    }
}
