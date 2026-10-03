// `install`: macOS from a restore image into a new golden image, in a fixed
// order, against an injected VZ layer so that every step and every way out
// can be tested without the 20 GB restore image:
//
//   refuse a directory that already holds an image's files,
//   read the restore image and its most featureful configuration for this Mac,
//   make disk.img (sparse), aux.img and a machine identifier,
//   run VZMacOSInstaller, reporting progress,
//   write config.json - last, so an image without it was never finished.
//
// Any failure, and a stop, removes what this run made and nothing else.

import Darwin
import Foundation

/// What a restore image says about itself and this Mac.
public struct RestoreImageInfo: Equatable {
    public var build: String
    /// `26.6.2`.
    public var os: String
    /// The hardware model of the most featureful configuration this Mac
    /// supports, or nil when it supports none.
    public var hardwareModel: Data?
    public var hardwareModelSupported: Bool
    public var minCpus: Int
    public var minMemoryBytes: UInt64

    public init(build: String, os: String, hardwareModel: Data?, hardwareModelSupported: Bool, minCpus: Int, minMemoryBytes: UInt64) {
        self.build = build
        self.os = os
        self.hardwareModel = hardwareModel
        self.hardwareModelSupported = hardwareModelSupported
        self.minCpus = minCpus
        self.minMemoryBytes = minMemoryBytes
    }
}

/// What the installer VM is built from.
public struct InstallPlan: Equatable {
    public var ipsw: String
    public var disk: String
    public var aux: String
    public var hardwareModel: Data
    /// One per slot, slot 1's first.
    public var machineIdentifiers: [Data]
    /// The slot whose lock the install holds.
    public var slot: Int
    public var cpus: Int
    public var memoryBytes: UInt64

    /// The identity the installer VM presents: its slot's.
    public var machineIdentifier: Data { machineIdentifiers[slot - macVMSlots.lowerBound] }
}

/// Virtualization.framework, as `install` uses it. Every callback is on the main queue.
public protocol InstallLayer {
    func loadRestoreImage(_ ipsw: String, _ done: @escaping (Result<RestoreImageInfo, Error>) -> Void)
    func newMachineIdentifier() -> Data
    func createAuxiliaryStorage(at path: String, hardwareModel: Data) throws
    /// Starts VZMacOSInstaller and returns what cancels it. `progress` gets
    /// the fraction done, 0 to 1.
    func install(_ plan: InstallPlan, progress: @escaping (Double) -> Void, done: @escaping (Error?) -> Void) -> () -> Void
}

/// What a command needs from the process, injected so that tests can watch it.
public struct Hooks {
    /// Writes one encoded line, newline included, to stdout.
    public var emit: (Data) -> Void
    /// Writes one log line to stderr: a level and a message.
    public var log: (String, String) -> Void
    /// Cleans up and exits with a code. Called exactly once.
    public var finish: (Int32) -> Void

    public init(emit: @escaping (Data) -> Void, log: @escaping (String, String) -> Void, finish: @escaping (Int32) -> Void) {
        self.emit = emit
        self.log = log
        self.finish = finish
    }

    /// Sends one event.
    public func send(_ fields: [String: Any]) {
        guard let line = encodeLine(fields) else {
            return log("error", "an event could not be encoded")
        }
        emit(line)
    }

    /// The last event of every command: `end`, ok or not, and why.
    public func end(_ error: HelperError?, reason: String, extra: [String: Any] = [:]) {
        var fields = extra
        fields["event"] = "end"
        fields["reason"] = reason
        fields["ok"] = error == nil
        if let e = error {
            fields["code"] = e.code.rawValue
            fields["message"] = bounded(e.message)
            log("error", e.message)
        }
        send(fields)
        finish(error?.code.exitCode ?? cleanExitCode)
    }
}

/// The installer VM's size: the restore image's minimums, raised to these.
public let installCpus = 4
public let installMemoryBytes: UInt64 = 4 << 30

public final class ImageInstall {
    private enum State { case idle, loading, installing, done }

    private let args: InstallArgs
    private let imageDir: String
    private let layer: InstallLayer
    private let hooks: Hooks
    private var state = State.idle
    private var cancel: (() -> Void)?
    private var made: [String] = []
    private var lastReported = -1

    public init(args: InstallArgs, imageDir: String, layer: InstallLayer, hooks: Hooks) {
        self.args = args
        self.imageDir = imageDir
        self.layer = layer
        self.hooks = hooks
    }

    public func begin() {
        guard state == .idle else { return }
        do {
            let dir = try openImageDir()
            defer { dir.close() }
            for name in [GoldenFile.config, GoldenFile.disk, GoldenFile.aux] {
                guard entry(in: dir.fd, name) == .missing else {
                    throw HelperError(.image, "\(imageDir) already holds \(name): install into a new image directory")
                }
            }
        } catch let e as HelperError {
            return fail(e)
        } catch {
            return fail(HelperError(.image, describe(error)))
        }
        state = .loading
        hooks.send(["event": "progress", "phase": "load", "percent": 0])
        layer.loadRestoreImage(args.ipsw) { [weak self] result in self?.loaded(result) }
    }

    private func openImageDir() throws -> RealDirectory {
        let dir: RealDirectory
        do {
            dir = try RealDirectory(imageDir)
        } catch let e as POSIXError {
            throw HelperError(.image, "the image directory \(imageDir) cannot be opened: \(e.message)")
        }
        guard dir.path == imageDir else {
            dir.close()
            throw HelperError(.image, "the image directory resolves to \(dir.path), not \(imageDir)")
        }
        return dir
    }

    private func loaded(_ result: Result<RestoreImageInfo, Error>) {
        guard state == .loading else { return }
        let info: RestoreImageInfo
        switch result {
        case .failure(let error):
            return fail(HelperError(.ipsw, "the restore image cannot be read: \(describe(error))"))
        case .success(let i):
            info = i
        }
        guard let model = info.hardwareModel, info.hardwareModelSupported else {
            return fail(HelperError(.ipsw, "this Mac cannot run macOS \(info.os) (\(info.build)) in a VM"))
        }
        hooks.send(["event": "image", "build": info.build, "os": info.os, "minCpus": info.minCpus,
                    "minMemoryBytes": NSNumber(value: info.minMemoryBytes)])

        let diskBytes = Int64(args.diskGiB) << 30
        // One identity per slot, slot 1's first; the installer VM presents the
        // one of the slot whose lock it holds, as every VM does.
        let machineIdentifiers = macVMSlots.map { _ in layer.newMachineIdentifier() }
        let plan = InstallPlan(
            ipsw: args.ipsw, disk: imageDir + "/" + GoldenFile.disk, aux: imageDir + "/" + GoldenFile.aux,
            hardwareModel: model, machineIdentifiers: machineIdentifiers, slot: args.slot,
            cpus: max(installCpus, info.minCpus), memoryBytes: max(installMemoryBytes, info.minMemoryBytes)
        )
        do {
            let dir = try openImageDir()
            defer { dir.close() }
            try createSparseDisk(in: dir.fd, GoldenFile.disk, bytes: diskBytes)
            made.append(GoldenFile.disk)
            made.append(GoldenFile.aux)
            try layer.createAuxiliaryStorage(at: plan.aux, hardwareModel: model)
        } catch let e as HelperError {
            return fail(e)
        } catch {
            return fail(HelperError(.install, "the image's disks cannot be made: \(describe(error))"))
        }

        state = .installing
        hooks.log("info", "installing macOS \(info.os) (\(info.build)) into \(imageDir)")
        cancel = layer.install(plan, progress: { [weak self] fraction in
            self?.progressed(fraction)
        }, done: { [weak self] error in
            self?.installed(error, info: info, plan: plan, diskBytes: diskBytes)
        })
    }

    private func progressed(_ fraction: Double) {
        guard state == .installing, fraction.isFinite else { return }
        // A whole percent at a time: VZ reports far more often than anyone reads.
        let percent = Int((min(max(fraction, 0), 1) * 100).rounded(.down))
        guard percent > lastReported else { return }
        lastReported = percent
        hooks.send(["event": "progress", "phase": "install", "percent": percent])
    }

    private func installed(_ error: Error?, info: RestoreImageInfo, plan: InstallPlan, diskBytes: Int64) {
        guard state == .installing else { return }
        cancel = nil
        if let error = error {
            return fail(HelperError(.install, "the installer failed: \(describe(error))"))
        }
        let config = ImageConfig(
            imageId: args.imageId, build: info.build, os: info.os, hardwareModel: plan.hardwareModel,
            machineIdentifiers: plan.machineIdentifiers, diskBytes: diskBytes, macAddress: newMACAddress(),
            minCpus: info.minCpus, minMemoryBytes: info.minMemoryBytes
        )
        do {
            let dir = try openImageDir()
            defer { dir.close() }
            try writeFileAtomically(in: dir.fd, GoldenFile.config, try config.encoded())
        } catch let e as HelperError {
            return fail(e)
        } catch {
            return fail(HelperError(.install, "config.json cannot be written: \(describe(error))"))
        }
        state = .done
        made = []
        hooks.end(nil, reason: "done", extra: ["build": info.build, "os": info.os, "diskBytes": NSNumber(value: diskBytes)])
    }

    /// A stop: from stdin, a signal, or the parent gone.
    public func stop(_ why: String) {
        switch state {
        case .done:
            return
        case .installing, .loading, .idle:
            hooks.log("info", "\(why): stopping the install")
            cancel?()
            cancel = nil
            removeMade()
            state = .done
            hooks.end(nil, reason: "requested")
        }
    }

    private func fail(_ e: HelperError) {
        guard state != .done else { return }
        cancel?()
        cancel = nil
        removeMade()
        state = .done
        hooks.end(e, reason: "error")
    }

    private func removeMade() {
        guard !made.isEmpty, let dir = try? openImageDir() else { return }
        defer { dir.close() }
        made.forEach { unlinkat(dir.fd, $0, 0) }
        made = []
    }
}

/// A new sparse file of `bytes`, created exclusively: nothing at the name is
/// replaced or followed.
public func createSparseDisk(in dirfd: Int32, _ name: String, bytes: Int64) throws {
    let fd = openat(dirfd, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else {
        throw HelperError(.install, "\(name) cannot be created: \(posixMessage())")
    }
    defer { close(fd) }
    guard ftruncate(fd, off_t(bytes)) == 0 else {
        let message = posixMessage()
        unlinkat(dirfd, name, 0)
        throw HelperError(.install, "\(name) cannot be sized to \(bytes) bytes: \(message)")
    }
}
