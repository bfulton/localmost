// Virtualization.framework behind MacVMCore's InstallLayer, and the two
// questions only VZ can answer: which restore image this Mac supports
// (`catalog`), and what a downloaded one holds (`inspect`). All three need
// the virtualization entitlement: without it VZ's installation service
// answers every catalog request with "unexpected error".

import Foundation
import MacVMCore
import Virtualization

final class VZInstallLayer: InstallLayer {
    private var installer: VZMacOSInstaller?
    private var observation: NSKeyValueObservation?

    func loadRestoreImage(_ ipsw: String, _ done: @escaping (Result<RestoreImageInfo, Error>) -> Void) {
        VZMacOSRestoreImage.load(from: URL(fileURLWithPath: ipsw)) { result in
            DispatchQueue.main.async {
                done(result.map(restoreImageInfo))
            }
        }
    }

    func newMachineIdentifier() -> Data {
        newMachineIdentifierData()
    }

    func createAuxiliaryStorage(at path: String, hardwareModel: Data) throws {
        guard let model = VZMacHardwareModel(dataRepresentation: hardwareModel) else {
            throw HelperError(.ipsw, "the restore image's hardware model cannot be read")
        }
        do {
            _ = try VZMacAuxiliaryStorage(creatingStorageAt: URL(fileURLWithPath: path), hardwareModel: model, options: [])
        } catch {
            throw HelperError(.install, "aux.img cannot be created: \(describe(error))")
        }
    }

    func install(_ plan: InstallPlan, progress: @escaping (Double) -> Void, done: @escaping (Error?) -> Void) -> () -> Void {
        let configuration: VZVirtualMachineConfiguration
        do {
            configuration = try makeConfiguration(MacSpec(
                purpose: .install, hardwareModel: plan.hardwareModel, machineIdentifier: plan.machineIdentifier,
                aux: plan.aux, disk: plan.disk, cpus: plan.cpus, memoryBytes: plan.memoryBytes
            ))
            try validate(configuration)
        } catch {
            DispatchQueue.main.async { done(error) }
            return {}
        }
        let vm = VZVirtualMachine(configuration: configuration)
        let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: URL(fileURLWithPath: plan.ipsw))
        self.installer = installer
        observation = installer.progress.observe(\.fractionCompleted, options: [.new]) { p, _ in
            let fraction = p.fractionCompleted
            DispatchQueue.main.async { progress(fraction) }
        }
        installer.install { [weak self] result in
            self?.observation?.invalidate()
            self?.observation = nil
            switch result {
            case .success: done(nil)
            case .failure(let error): done(error)
            }
        }
        return { [weak installer] in installer?.progress.cancel() }
    }
}

private func restoreImageInfo(_ image: VZMacOSRestoreImage) -> RestoreImageInfo {
    let v = image.operatingSystemVersion
    let requirements = image.mostFeaturefulSupportedConfiguration
    return RestoreImageInfo(
        build: image.buildVersion,
        os: versionString(major: v.majorVersion, minor: v.minorVersion, patch: v.patchVersion),
        hardwareModel: requirements?.hardwareModel.dataRepresentation,
        hardwareModelSupported: requirements?.hardwareModel.isSupported ?? false,
        minCpus: requirements?.minimumSupportedCPUCount ?? 0,
        minMemoryBytes: requirements?.minimumSupportedMemorySize ?? 0
    )
}

/// `catalog`: the latest restore image this Mac supports, as one event.
func runCatalog(_ hooks: Hooks) -> Never {
    VZMacOSRestoreImage.fetchLatestSupported { result in
        DispatchQueue.main.async {
            switch result {
            case .failure(let error):
                hooks.end(HelperError(.catalog, "the restore image catalog cannot be fetched: \(describe(error))"), reason: "error")
            case .success(let image):
                guard isAllowedRestoreImageURL(image.url) else {
                    return hooks.end(HelperError(.catalog, "the catalog named a URL off the allowlist: \(quoted(image.url.absoluteString))"),
                                     reason: "error")
                }
                let info = restoreImageInfo(image)
                hooks.end(nil, reason: "done", extra: [
                    "url": image.url.absoluteString, "build": info.build, "os": info.os,
                    "supported": info.hardwareModel != nil && info.hardwareModelSupported,
                    "minCpus": info.minCpus, "minMemoryBytes": NSNumber(value: info.minMemoryBytes),
                ])
            }
        }
    }
    dispatchMain()
}

/// `inspect`: a downloaded restore image's version and whether this Mac can run it.
func runInspect(ipsw: String, _ hooks: Hooks) -> Never {
    VZInstallLayer().loadRestoreImage(ipsw) { result in
        switch result {
        case .failure(let error):
            hooks.end(HelperError(.ipsw, "the restore image cannot be read: \(describe(error))"), reason: "error")
        case .success(let info):
            hooks.end(nil, reason: "done", extra: [
                "build": info.build, "os": info.os,
                "supported": info.hardwareModel != nil && info.hardwareModelSupported,
                "minCpus": info.minCpus, "minMemoryBytes": NSNumber(value: info.minMemoryBytes),
            ])
        }
    }
    dispatchMain()
}
