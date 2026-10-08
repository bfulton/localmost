import XCTest
@testable import MacVMCore

/// VZ as `install` uses it, faked: what it was asked, in order.
final class FakeInstallLayer: InstallLayer {
    var info: Result<RestoreImageInfo, Error> = .success(RestoreImageInfo(
        build: "25G83", os: "26.6.2", hardwareModel: Data([1, 2, 3]), hardwareModelSupported: true, minCpus: 2,
        minMemoryBytes: 4 << 30))
    var calls: [String] = []
    var plan: InstallPlan?
    var progress: ((Double) -> Void)?
    var done: ((Error?) -> Void)?
    var cancelled = false
    var auxError: Error?
    var identifiers = 0

    func loadRestoreImage(_ ipsw: String, _ done: @escaping (Result<RestoreImageInfo, Error>) -> Void) {
        calls.append("load \((ipsw as NSString).lastPathComponent)")
        done(info)
    }

    func newMachineIdentifier() -> Data {
        identifiers += 1
        calls.append("identifier")
        return Data([9, UInt8(identifiers)])
    }

    func createAuxiliaryStorage(at path: String, hardwareModel: Data) throws {
        calls.append("aux")
        if let e = auxError { throw e }
        FileManager.default.createFile(atPath: path, contents: Data(repeating: 1, count: 128))
    }

    func install(_ plan: InstallPlan, progress: @escaping (Double) -> Void, done: @escaping (Error?) -> Void) -> () -> Void {
        calls.append("install")
        self.plan = plan
        self.progress = progress
        self.done = done
        return { [weak self] in self?.cancelled = true }
    }
}

final class InstallTests: XCTestCase {
    private var tmp: TempDir!
    private var layer: FakeInstallLayer!
    private var rec: Recorder!
    private var imageDir: String!

    override func setUpWithError() throws {
        tmp = try TempDir()
        layer = FakeInstallLayer()
        rec = Recorder()
        try tmp.mkdir("data/macos-vm/images/a1b2c3d4e5f6")
        imageDir = tmp.real + "/data/macos-vm/images/a1b2c3d4e5f6"
    }

    override func tearDown() {
        tmp = nil
    }

    private func install() -> ImageInstall {
        let args = InstallArgs(dataDir: tmp.real + "/data", imageId: "a1b2c3d4e5f6",
                               ipsw: tmp.real + "/data/macos-vm/ipsw/r.ipsw", diskGiB: 64, slot: 1)
        return ImageInstall(args: args, imageDir: imageDir, layer: layer, hooks: rec.hooks)
    }

    private var files: [String] { ((try? FileManager.default.contentsOfDirectory(atPath: imageDir)) ?? []).sorted() }

    func testInstallsInOrderAndWritesTheConfigLast() throws {
        let i = install()
        i.begin()
        XCTAssertEqual(layer.calls, ["load r.ipsw", "identifier", "identifier", "aux", "install"])
        XCTAssertEqual(files, ["aux.img", "disk.img"], "no config.json until the installer finished")
        let attrs = try FileManager.default.attributesOfItem(atPath: imageDir + "/disk.img")
        XCTAssertEqual(attrs[.size] as? Int64, 64 << 30)
        XCTAssertEqual(layer.plan?.cpus, installCpus)
        XCTAssertEqual(layer.plan?.memoryBytes, installMemoryBytes)
        // The install, and later the provisioning boot, present slot 1's identity.
        XCTAssertEqual(layer.plan?.machineIdentifier, Data([9, 1]))

        for f in [0.001, 0.004, 0.011, 0.5, 0.505, 0.51, 1.0, 1.0] { layer.progress?(f) }
        XCTAssertEqual(rec.named("progress").compactMap { $0["phase"] as? String == "install" ? $0["percent"] as? Int : nil }, [0, 1, 50, 51, 100])

        layer.done?(nil)
        XCTAssertEqual(files, ["aux.img", "config.json", "disk.img"])
        let config = try ImageConfig.decode(try Data(contentsOf: URL(fileURLWithPath: imageDir + "/config.json")), imageId: "a1b2c3d4e5f6")
        XCTAssertEqual(config.build, "25G83")
        XCTAssertEqual(config.diskBytes, 64 << 30)
        XCTAssertEqual(config.machineIdentifierData(slot: 1), Data([9, 1]))
        XCTAssertEqual(config.machineIdentifierData(slot: 2), Data([9, 2]))
        XCTAssertTrue(isMACAddress(config.macAddress))
        XCTAssertEqual(rec.last["event"] as? String, "end")
        XCTAssertEqual(rec.last["ok"] as? Bool, true)
        XCTAssertEqual(rec.exitCode, 0)
        // The image is now complete and checks.
        XCTAssertNoThrow(try checkImage(imageDir, imageId: "a1b2c3d4e5f6"))
    }

    func testTheInstallerPresentsTheIdentityOfTheSlotItHolds() throws {
        let args = InstallArgs(dataDir: tmp.real + "/data", imageId: "a1b2c3d4e5f6",
                               ipsw: tmp.real + "/data/macos-vm/ipsw/r.ipsw", diskGiB: 64, slot: 2)
        ImageInstall(args: args, imageDir: imageDir, layer: layer, hooks: rec.hooks).begin()
        XCTAssertEqual(layer.plan?.machineIdentifier, Data([9, 2]))
    }

    func testAFailedInstallLeavesNothingBehind() {
        let i = install()
        i.begin()
        layer.done?(NSError(domain: "VZErrorDomain", code: 10007))
        XCTAssertEqual(files, [])
        XCTAssertEqual(rec.last["code"] as? String, "E_INSTALL")
        XCTAssertEqual(rec.exitCode, ErrorCode.install.exitCode)
    }

    func testAStopCancelsTheInstallerAndLeavesNothingBehind() {
        let i = install()
        i.begin()
        i.stop("SIGTERM")
        XCTAssertTrue(layer.cancelled)
        XCTAssertEqual(files, [])
        XCTAssertEqual(rec.last["reason"] as? String, "requested")
        XCTAssertEqual(rec.exitCode, 0)
        // The installer's late completion is ignored.
        layer.done?(nil)
        XCTAssertEqual(files, [])
    }

    func testAnImageThisMacCannotRunIsRefusedBeforeAnythingIsMade() {
        layer.info = .success(RestoreImageInfo(build: "27A1", os: "27.0.0", hardwareModel: nil, hardwareModelSupported: false,
                                               minCpus: 2, minMemoryBytes: 1))
        install().begin()
        XCTAssertEqual(layer.calls, ["load r.ipsw"])
        XCTAssertEqual(files, [])
        XCTAssertEqual(rec.last["code"] as? String, "E_IPSW")
    }

    func testAnUnreadableRestoreImageIsRefused() {
        layer.info = .failure(NSError(domain: "VZErrorDomain", code: 1))
        install().begin()
        XCTAssertEqual(rec.last["code"] as? String, "E_IPSW")
        XCTAssertEqual(files, [])
    }

    func testAnAuxFailureRemovesTheDisk() {
        layer.auxError = HelperError(.install, "no aux")
        install().begin()
        XCTAssertEqual(files, [])
        XCTAssertEqual(rec.last["code"] as? String, "E_INSTALL")
    }

    func testADirectoryThatHoldsAnImageIsNeverInstalledInto() throws {
        try tmp.write("data/macos-vm/images/a1b2c3d4e5f6/disk.img", Data("old".utf8))
        install().begin()
        XCTAssertEqual(layer.calls, [])
        XCTAssertEqual(files, ["disk.img"])
        XCTAssertEqual(FileManager.default.contents(atPath: imageDir + "/disk.img"), Data("old".utf8))
        XCTAssertEqual(rec.last["code"] as? String, "E_IMAGE")
    }
}
