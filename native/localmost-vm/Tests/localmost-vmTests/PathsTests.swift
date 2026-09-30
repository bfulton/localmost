import XCTest
@testable import localmost_vm

/// The share checks of contract §2.1, on real directories: the one directory
/// that passes, and each way a job could make the helper share something else.
final class ShareTests: XCTestCase {
    private let sid = "3-a1b2c3d4e5f6"
    private var tmp: TempDir!
    /// `<data>`, real, as HelperPaths hands it on.
    private var data: String { tmp.real + "/data" }
    private var sandboxes: String { tmp.sub("data/runner/sandbox") }
    private var sandbox: String { tmp.sub("data/runner/sandbox/\(sid)") }
    /// The VM's own directory: the share must be on its device.
    private var vmDir: String { tmp.real + "/data/vm/jobs/3-0123456789ab" }

    override func setUpWithError() throws {
        tmp = try TempDir()
        try tmp.mkdir("data/runner/sandbox/\(sid)/_work")
        try tmp.mkdir("data/vm/jobs/3-0123456789ab")
    }

    override func tearDown() {
        tmp = nil
    }

    private func assertRefused(_ why: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try validateShare(dataDir: data, sandboxId: sid, sameDeviceAs: vmDir), why, file: file, line: line) { error in
            XCTAssertEqual((error as? HelperError)?.code, .share, "\(why): \(error)", file: file, line: line)
        }
    }

    func testTheSandboxesOwnWorkDirectoryPasses() throws {
        let share = try validateShare(dataDir: data, sandboxId: sid, sameDeviceAs: vmDir)
        XCTAssertEqual(share, try realPath(sandbox) + "/_work")
        XCTAssertTrue(share.hasPrefix("/private/"), "the share is the real path, not the /var link: \(share)")
    }

    func testAWorkDirectoryThatIsALinkIsRefused() throws {
        try FileManager.default.removeItem(atPath: sandbox + "/_work")
        try tmp.mkdir("elsewhere")
        try tmp.symlink("data/runner/sandbox/\(sid)/_work", to: tmp.sub("elsewhere"))
        assertRefused("_work is a link to a directory outside the sandbox")
    }

    func testAWorkDirectoryThatIsALinkInsideTheSandboxIsRefused() throws {
        try FileManager.default.removeItem(atPath: sandbox + "/_work")
        try tmp.mkdir("data/runner/sandbox/\(sid)/real")
        try tmp.symlink("data/runner/sandbox/\(sid)/_work", to: "real")
        assertRefused("_work is a link to a sibling")
    }

    func testAWorkLinkToHomeIsRefused() throws {
        try FileManager.default.removeItem(atPath: sandbox + "/_work")
        try tmp.symlink("data/runner/sandbox/\(sid)/_work", to: NSHomeDirectory())
        assertRefused("_work is a link to the home directory")
    }

    func testASymlinkedSandboxIsRefused() throws {
        try FileManager.default.removeItem(atPath: sandbox)
        try tmp.mkdir("outside/_work")
        try tmp.symlink("data/runner/sandbox/\(sid)", to: tmp.sub("outside"))
        assertRefused("the sandbox is a link to a directory outside runner/sandbox")
    }

    func testASandboxLinkedToAnotherSandboxIsRefused() throws {
        try FileManager.default.removeItem(atPath: sandbox)
        try tmp.mkdir("data/runner/sandbox/4-a1b2c3d4e5f6/_work")
        try tmp.symlink("data/runner/sandbox/\(sid)", to: "4-a1b2c3d4e5f6")
        assertRefused("the sandbox is a link to another worker's sandbox")
    }

    func testAMissingWorkDirectoryIsRefused() throws {
        try FileManager.default.removeItem(atPath: sandbox + "/_work")
        assertRefused("_work does not exist")
    }

    func testAWorkFileIsRefused() throws {
        try FileManager.default.removeItem(atPath: sandbox + "/_work")
        try tmp.write("data/runner/sandbox/\(sid)/_work", 4)
        assertRefused("_work is a file")
    }

    func testAMissingSandboxIsRefused() throws {
        try FileManager.default.removeItem(atPath: sandbox)
        assertRefused("the sandbox does not exist")
    }

    func testARealPathOutsideRunnerSandboxIsRefused() throws {
        // Every directory is real, but runner/sandbox above the sandbox is a
        // link: the share resolves outside <data>, so it is not the sandbox's.
        try FileManager.default.removeItem(atPath: sandboxes)
        try tmp.mkdir("other/\(sid)/_work")
        try tmp.symlink("data/runner/sandbox", to: tmp.sub("other"))
        assertRefused("runner/sandbox is a link to a directory outside <data>")
    }

    func testADataDirectoryThatIsNotRealIsRefused() throws {
        // HelperPaths passes the real <data>; a path through /var, a link to
        // /private/var, resolves elsewhere and is not taken on trust.
        XCTAssertThrowsError(try validateShare(dataDir: tmp.sub("data"), sandboxId: sid, sameDeviceAs: vmDir)) {
            XCTAssertEqual(($0 as? HelperError)?.code, .share)
        }
    }

    func testAnInvalidSandboxIdIsRefused() {
        for bad in ["../3-a1b2c3d4e5f6", "3-a1b2c3d4e5f6/..", ""] {
            XCTAssertThrowsError(try validateShare(dataDir: data, sandboxId: bad, sameDeviceAs: vmDir), bad) {
                XCTAssertEqual(($0 as? HelperError)?.code, .share)
            }
        }
    }

    // A mount over _work, the sandbox, or anything between them and <data>
    // is invisible to seatbelt's path rules. A DMG stands in for a FUSE or
    // SMB mount: it needs no prompt.

    func testAShareOnAnotherDeviceThanTheVmIsRefused() throws {
        let mount = try DiskImage(tmp, mountOn: try tmp.mkdir("elsewhere"))
        defer { mount.detach() }
        try tmp.mkdir("elsewhere/jobs/3-0123456789ab")
        XCTAssertThrowsError(try validateShare(dataDir: data, sandboxId: sid, sameDeviceAs: tmp.real + "/elsewhere/jobs/3-0123456789ab")) {
            XCTAssertEqual(($0 as? HelperError)?.code, .share)
        }
    }

    func testADiskImageMountedOverRunnerSandboxIsRefused() throws {
        let mount = try DiskImage(tmp, mountOn: sandboxes)
        defer { mount.detach() }
        try FileManager.default.createDirectory(atPath: sandbox + "/_work", withIntermediateDirectories: true)
        assertRefused("a disk image holding the sandbox is mounted over runner/sandbox")
    }

    func testADiskImageMountedOverWorkIsRefused() throws {
        let mount = try DiskImage(tmp, mountOn: sandbox + "/_work")
        defer { mount.detach() }
        assertRefused("a disk image is mounted over _work")
    }

    func testADiskImageMountedOverTheSandboxIsRefused() throws {
        let mount = try DiskImage(tmp, mountOn: sandbox)
        defer { mount.detach() }
        try FileManager.default.createDirectory(atPath: sandbox + "/_work", withIntermediateDirectories: false)
        assertRefused("a disk image holding _work is mounted over the sandbox")
    }
}

/// The guest artifact checks: sizes from manifest.json (contract §2.1).
final class GuestImageTests: XCTestCase {
    private var tmp: TempDir!

    override func setUpWithError() throws {
        tmp = try TempDir()
        try tmp.write("res/guest/vmlinux", 300)
        try tmp.write("res/guest/initramfs.cpio.gz", 20)
        try tmp.write("res/guest/rootfs.erofs", 4096)
        try writeManifest(["vmlinux": 300, "initramfs.cpio.gz": 20, "rootfs.erofs": 4096])
    }

    override func tearDown() {
        tmp = nil
    }

    private func writeManifest(_ sizes: [String: Any], schema: Any = 1) throws {
        var artifacts: [String: Any] = [:]
        for (name, size) in sizes {
            artifacts[name] = ["sha256": String(repeating: "0", count: 64), "size": size]
        }
        let manifest: [String: Any] = ["schema": schema, "guestVersion": "test", "artifacts": artifacts]
        try tmp.write("res/guest/manifest.json", try JSONSerialization.data(withJSONObject: manifest))
    }

    private func assertRefused(_ why: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try checkGuestImage(resources: tmp.sub("res")), why, file: file, line: line) { error in
            XCTAssertEqual((error as? HelperError)?.code, .guestImage, "\(why): \(error)", file: file, line: line)
        }
    }

    func testArtifactsOfTheManifestSizesPass() throws {
        let g = try checkGuestImage(resources: tmp.sub("res"))
        XCTAssertEqual(g.kernel, tmp.real + "/res/guest/vmlinux")
        XCTAssertEqual(g.initramfs, tmp.real + "/res/guest/initramfs.cpio.gz")
        XCTAssertEqual(g.rootfs, tmp.real + "/res/guest/rootfs.erofs")
    }

    func testAWrongSizeIsRefused() throws {
        try tmp.write("res/guest/rootfs.erofs", 4095)
        assertRefused("rootfs.erofs one byte short")
    }

    func testEachMissingArtifactIsRefused() throws {
        for name in ["vmlinux", "initramfs.cpio.gz", "rootfs.erofs"] {
            let p = tmp.sub("res/guest/\(name)")
            let saved = try Data(contentsOf: URL(fileURLWithPath: p))
            try FileManager.default.removeItem(atPath: p)
            assertRefused("\(name) missing")
            try tmp.write("res/guest/\(name)", saved)
        }
    }

    func testAnArtifactThatIsALinkIsRefused() throws {
        try tmp.write("elsewhere", 4096)
        try FileManager.default.removeItem(atPath: tmp.sub("res/guest/rootfs.erofs"))
        try tmp.symlink("res/guest/rootfs.erofs", to: tmp.sub("elsewhere"))
        assertRefused("rootfs.erofs is a link")
    }

    func testAnArtifactThatIsADirectoryIsRefused() throws {
        try FileManager.default.removeItem(atPath: tmp.sub("res/guest/vmlinux"))
        try tmp.mkdir("res/guest/vmlinux")
        try writeManifest(["vmlinux": 64, "initramfs.cpio.gz": 20, "rootfs.erofs": 4096])
        assertRefused("vmlinux is a directory")
    }

    func testAManifestWithoutAnArtifactIsRefused() throws {
        try writeManifest(["vmlinux": 300, "initramfs.cpio.gz": 20])
        assertRefused("no rootfs.erofs in the manifest")
    }

    func testAManifestSizeThatIsNotANonNegativeIntegerIsRefused() throws {
        for bad: Any in ["4096", 4096.5, -1, true, NSNull()] {
            try writeManifest(["vmlinux": 300, "initramfs.cpio.gz": 20, "rootfs.erofs": bad])
            assertRefused("size \(bad)")
        }
    }

    func testAnotherSchemaIsRefused() throws {
        try writeManifest(["vmlinux": 300, "initramfs.cpio.gz": 20, "rootfs.erofs": 4096], schema: 2)
        assertRefused("schema 2")
    }

    func testAMissingOrMalformedManifestIsRefused() throws {
        try tmp.write("res/guest/manifest.json", Data("{".utf8))
        assertRefused("truncated JSON")
        try tmp.write("res/guest/manifest.json", Data("[]".utf8))
        assertRefused("not an object")
        try FileManager.default.removeItem(atPath: tmp.sub("res/guest/manifest.json"))
        assertRefused("no manifest")
    }

    func testAnOversizedManifestIsRefusedWithoutParsing() throws {
        var big = Data("{\"schema\":1,\"pad\":\"".utf8)
        big.append(Data(repeating: 0x61, count: 2 << 20))
        big.append(Data("\"}".utf8))
        try tmp.write("res/guest/manifest.json", big)
        assertRefused("a 2 MiB manifest")
    }

    func testAMissingGuestDirectoryIsRefused() throws {
        try FileManager.default.removeItem(atPath: tmp.sub("res/guest"))
        assertRefused("no guest directory")
    }
}

/// The data disk (contract §2.1): the file Electron prepared, never a link.
final class DataDiskTests: XCTestCase {
    func testAPreparedDiskPassesAndAnythingElseIsRefused() throws {
        let tmp = try TempDir()
        let disk = try tmp.write("data.img", 4096)
        XCTAssertNoThrow(try checkDataDisk(disk))

        try tmp.symlink("link.img", to: disk)
        for (path, why) in [(tmp.sub("missing.img"), "missing"), (tmp.sub("link.img"), "a link"), (try tmp.mkdir("dir.img"), "a directory")] {
            XCTAssertThrowsError(try checkDataDisk(path), why) { error in
                XCTAssertEqual((error as? HelperError)?.code, .disk, why)
            }
        }
    }

    func testTheDiskPathFollowsTheMode() throws {
        let data = "/private/tmp/d"
        XCTAssertEqual(dataDiskPath(dataDir: data, vmId: "3-0123456789ab", mode: .job(sandboxId: "3-a1b2c3d4e5f6", proxyPort: 1)),
                       "/private/tmp/d/vm/jobs/3-0123456789ab/data.img")
        XCTAssertEqual(dataDiskPath(dataDir: data, vmId: "0-0123456789ab", mode: .refresh(repoKey: "0123456789abcdef")),
                       "/private/tmp/d/vm/cache/0123456789abcdef/data.img.new")
    }
}

/// The paths the helper derives from its arguments (contract §1).
final class HelperPathsTests: XCTestCase {
    func testEverythingIsDerivedFromTheRealDataDirectoryAndTheIds() throws {
        let tmp = try TempDir()
        try tmp.mkdir("data/vm/jobs/3-0123456789ab")
        try tmp.mkdir("res")
        let args = RunArgs(vmId: "3-0123456789ab", slot: 3, mode: .job(sandboxId: "3-a1b2c3d4e5f6", proxyPort: 1),
                           dataDir: tmp.sub("data"), resources: tmp.sub("res"), cpus: 1, memoryMiB: 1024, rosetta: .off)
        let p = try HelperPaths(args)
        let vm = tmp.real + "/data/vm/jobs/3-0123456789ab"
        XCTAssertEqual(p.dataDir, tmp.real + "/data", "resolved from the VM directory it opened, not by walking <data>'s parents")
        XCTAssertEqual(p.vmDir, vm)
        XCTAssertEqual(p.dockerSocket, vm + "/docker.sock")
        XCTAssertEqual(p.agentSocket, vm + "/agent.sock")
        XCTAssertEqual(p.consoleLog, vm + "/console.log")
        XCTAssertEqual(p.pidFile, vm + "/helper.pid")
        XCTAssertEqual(p.dataDisk, vm + "/data.img")
    }

    func testAMissingDataDirectoryOrVmDirectoryIsAnArgumentError() throws {
        let tmp = try TempDir()
        try tmp.mkdir("data/vm/jobs")
        try tmp.mkdir("res")
        var args = RunArgs(vmId: "3-0123456789ab", slot: 3, mode: .job(sandboxId: "3-a1b2c3d4e5f6", proxyPort: 1),
                           dataDir: tmp.sub("data"), resources: tmp.sub("res"), cpus: 1, memoryMiB: 1024, rosetta: .off)
        XCTAssertThrowsError(try HelperPaths(args), "no VM directory") { XCTAssertEqual(($0 as? HelperError)?.code, .args) }
        try tmp.symlink("data/vm/jobs/3-0123456789ab", to: tmp.sub("res"))
        XCTAssertThrowsError(try HelperPaths(args), "the VM directory is a link") { XCTAssertEqual(($0 as? HelperError)?.code, .args) }
        args.dataDir = tmp.sub("nodata")
        XCTAssertThrowsError(try HelperPaths(args), "no data directory") { XCTAssertEqual(($0 as? HelperError)?.code, .args) }
    }

    func testALinkBetweenDataAndTheVmDirectoryIsAnArgumentError() throws {
        let tmp = try TempDir()
        try tmp.mkdir("elsewhere/jobs/3-0123456789ab")
        try tmp.mkdir("data")
        try tmp.symlink("data/vm", to: tmp.sub("elsewhere"))
        let args = RunArgs(vmId: "3-0123456789ab", slot: 3, mode: .job(sandboxId: "3-a1b2c3d4e5f6", proxyPort: 1),
                           dataDir: tmp.sub("data"), resources: tmp.sub("res"), cpus: 1, memoryMiB: 1024, rosetta: .off)
        XCTAssertThrowsError(try HelperPaths(args), "<data>/vm is a link") { XCTAssertEqual(($0 as? HelperError)?.code, .args) }
    }
}

/// A read-write HFS+ disk image attached with no Finder window and no
/// prompt, mounted over a given directory.
final class DiskImage {
    private let mountPoint: String
    private var attached = false

    init(_ tmp: TempDir, mountOn mountPoint: String) throws {
        self.mountPoint = mountPoint
        let image = tmp.sub("img-\(UUID().uuidString.prefix(6)).dmg")
        // hdiutil on a busy CI machine sometimes answers "Resource busy"; try again.
        var last = ""
        for attempt in 1...3 {
            let made = try run("/usr/bin/hdiutil", ["create", "-quiet", "-size", "2m", "-fs", "HFS+", "-volname", "lmvmtest", "-ov", image])
            if made.status == 0 {
                let a = try run("/usr/bin/hdiutil", ["attach", "-quiet", "-nobrowse", "-noverify", "-noautoopen", "-owners", "on",
                                                     "-mountpoint", mountPoint, image])
                if a.status == 0 {
                    attached = true
                    return
                }
                last = "attach: \(a.output)"
            } else {
                last = "create: \(made.output)"
            }
            Thread.sleep(forTimeInterval: Double(attempt))
        }
        throw NSError(domain: "DiskImage", code: 1, userInfo: [NSLocalizedDescriptionKey: "hdiutil failed: \(last)"])
    }

    func detach() {
        guard attached else { return }
        for args in [["detach", "-quiet", mountPoint], ["detach", "-quiet", "-force", mountPoint]] {
            if (try? run("/usr/bin/hdiutil", args))?.status == 0 {
                attached = false
                return
            }
        }
    }

    deinit {
        detach()
    }
}
