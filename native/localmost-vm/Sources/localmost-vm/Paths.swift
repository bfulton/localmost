// Every path the helper uses, derived from its arguments (contract §1 and
// §2.1), and the checks that close G-A at the helper's layer: the share must
// be the sandbox's own `_work`, a real directory, with nothing mounted over
// it or over anything between it and `<data>`.
//
// Paths are resolved from file descriptors, never by walking parents: each
// directory is opened with O_NOFOLLOW and its real path read back with
// F_GETPATH. Under the helper's deny-default profile a realpath(3) walk
// fails, because it must read the metadata of `<data>`'s ancestors, which
// the profile does not grant; opening a granted directory needs nothing more.

import Darwin
import Foundation

/// The files of the guest image in `<resources>/guest`, by their real paths.
struct GuestArtifacts: Equatable {
    var kernel: String
    var initramfs: String
    var rootfs: String
}

/// What the helper reads and writes, all under the real `<data>`.
struct HelperPaths {
    /// `<data>`, real: resolved once, from the VM's own directory.
    let dataDir: String
    /// `<data>/vm/jobs/<vmId>`, made by VmManager before the spawn.
    let vmDir: String
    let dockerSocket: String
    let agentSocket: String
    let consoleLog: String
    let pidFile: String
    let dataDisk: String

    /// Opens `<data>/vm/jobs/<vmId>` and reads its real path, which gives the
    /// real `<data>`. A missing VM directory, or a link anywhere from `<data>`
    /// down to it, is an argument error: the helper creates none of these,
    /// and its profile grants only their real paths.
    init(_ args: RunArgs) throws {
        let suffix = "/vm/jobs/" + args.vmId
        let given = args.dataDir + suffix
        let vm: String
        do {
            let dir = try RealDirectory(given)
            vm = dir.path
            dir.close()
        } catch let e as POSIXError {
            throw HelperError(.args, "the VM directory \(given) cannot be opened: \(e.message)")
        }
        guard vm.hasSuffix(suffix) else {
            throw HelperError(.args, "the VM directory \(given) resolves to \(vm)")
        }
        dataDir = String(vm.dropLast(suffix.count))
        vmDir = vm
        dockerSocket = vm + "/docker.sock"
        agentSocket = vm + "/agent.sock"
        consoleLog = vm + "/console.log"
        pidFile = vm + "/helper.pid"
        dataDisk = dataDiskPath(dataDir: dataDir, vmId: args.vmId, mode: args.mode)
    }
}

/// The data disk Electron prepared: the VM's own clone in job mode, the
/// repository's refresh clone in refresh mode.
func dataDiskPath(dataDir: String, vmId: String, mode: Mode) -> String {
    switch mode {
    case .job:
        return dataDir + "/vm/jobs/" + vmId + "/data.img"
    case .refresh(let repoKey):
        return dataDir + "/vm/cache/" + repoKey + "/data.img.new"
    }
}

/// The share for a job VM, `<data>/runner/sandbox/<sandboxId>/_work`, after
/// the checks of §2.1. `dataDir` is the real `<data>` from HelperPaths.
///
/// - It is opened with O_NOFOLLOW as a directory: not a link, not a file.
/// - Its real path is exactly that path: no link at the sandbox, at
///   runner/sandbox, or anywhere else below `<data>` moved it.
/// - It is on the same filesystem as the VM's own directory, and it is not
///   itself a mount point: nothing (a DMG, FUSE or SMB mount, which the job
///   profile's path rules do not see) is mounted over `_work`, the sandbox,
///   or any directory between them and `<data>`.
func validateShare(dataDir: String, sandboxId: String, sameDeviceAs reference: String) throws -> String {
    guard isSlotId(sandboxId) else {
        throw HelperError(.share, "sandbox id \(quoted(sandboxId)) is not <slot>-<12 hex>")
    }
    let share = dataDir + "/runner/sandbox/" + sandboxId + "/_work"
    let dir: RealDirectory
    do {
        dir = try RealDirectory(share)
    } catch let e as POSIXError {
        switch e.code {
        case .ENOENT: throw HelperError(.share, "the share \(share) does not exist")
        case .ELOOP, .ENOTDIR: throw HelperError(.share, "the share \(share) is a link or not a directory")
        default: throw HelperError(.share, "the share \(share) cannot be opened: \(e.message)")
        }
    }
    defer { dir.close() }
    guard dir.path == share else {
        throw HelperError(.share, "the share resolves to \(dir.path), not \(share)")
    }

    let ref: RealDirectory
    do {
        ref = try RealDirectory(reference)
    } catch let e as POSIXError {
        throw HelperError(.share, "\(reference) cannot be opened: \(e.message)")
    }
    defer { ref.close() }
    guard let shareFs = dir.filesystem(), let refFs = ref.filesystem() else {
        throw HelperError(.share, "the share's filesystem cannot be examined: \(posixMessage())")
    }
    guard shareFs.device == refFs.device, shareFs.fsid == refFs.fsid else {
        throw HelperError(.share, "the share \(share) is on another filesystem: something is mounted over it or a directory above it")
    }
    guard shareFs.mountedOn != share else {
        throw HelperError(.share, "something is mounted over the share \(share)")
    }
    return share
}

/// The most manifest.json may be. It lists the guest's packages; a real one is
/// tens of KiB.
let maxManifestBytes = 1 << 20

/// Checks each guest artifact's size against `manifest.json`. Electron checks
/// the hashes once per launch (§5.4); the size check here catches a guest
/// replaced or truncated since, without reading a 100 MB file.
func checkGuestImage(resources: String) throws -> GuestArtifacts {
    let guest: RealDirectory
    do {
        guest = try RealDirectory(resources + "/guest")
    } catch let e as POSIXError {
        throw HelperError(.guestImage, "the guest directory \(resources)/guest cannot be opened: \(e.message)")
    }
    defer { guest.close() }

    let manifest = try readManifest(guest.fd)
    guard let schema = manifest["schema"] as? NSNumber, isInteger(schema), schema.intValue == 1 else {
        throw HelperError(.guestImage, "manifest.json is not schema 1")
    }
    guard let artifacts = manifest["artifacts"] as? [String: Any] else {
        throw HelperError(.guestImage, "manifest.json has no artifacts")
    }
    func checked(_ name: String) throws -> String {
        guard let entry = artifacts[name] as? [String: Any], let size = entry["size"] as? NSNumber, isInteger(size),
              size.int64Value >= 0
        else {
            throw HelperError(.guestImage, "manifest.json has no size for \(name)")
        }
        var st = stat()
        guard fstatat(guest.fd, name, &st, AT_SYMLINK_NOFOLLOW) == 0 else {
            throw HelperError(.guestImage, "\(name) is missing")
        }
        guard st.st_mode & S_IFMT == S_IFREG else {
            throw HelperError(.guestImage, "\(name) is a link or not a regular file")
        }
        guard Int64(st.st_size) == size.int64Value else {
            throw HelperError(.guestImage, "\(name) is \(st.st_size) bytes; the manifest says \(size.int64Value)")
        }
        return guest.path + "/" + name
    }
    return GuestArtifacts(
        kernel: try checked("vmlinux"),
        initramfs: try checked("initramfs.cpio.gz"),
        rootfs: try checked("rootfs.erofs")
    )
}

private func readManifest(_ dirfd: Int32) throws -> [String: Any] {
    let fd = openat(dirfd, "manifest.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else {
        throw HelperError(.guestImage, "manifest.json cannot be opened: \(posixMessage())")
    }
    defer { close(fd) }
    var data = Data()
    var buf = [UInt8](repeating: 0, count: 64 << 10)
    while true {
        let n = read(fd, &buf, buf.count)
        if n < 0 {
            if errno == EINTR { continue }
            throw HelperError(.guestImage, "manifest.json cannot be read: \(posixMessage())")
        }
        if n == 0 { break }
        data.append(buf, count: n)
        if data.count > maxManifestBytes {
            throw HelperError(.guestImage, "manifest.json is over \(maxManifestBytes) bytes")
        }
    }
    guard let object = try? JSONSerialization.jsonObject(with: data), let dict = object as? [String: Any] else {
        throw HelperError(.guestImage, "manifest.json is not a JSON object")
    }
    return dict
}

/// The data disk must be the regular file Electron prepared, not a link.
func checkDataDisk(_ path: String) throws {
    guard let st = lstatOf(path) else {
        throw HelperError(.disk, "the data disk \(path) is missing")
    }
    guard st.st_mode & S_IFMT == S_IFREG else {
        throw HelperError(.disk, "the data disk \(path) is a link or not a regular file")
    }
}

// MARK: - Helpers

/// A directory opened with O_NOFOLLOW, and its real path as the kernel knows it.
struct RealDirectory {
    let fd: Int32
    let path: String

    init(_ path: String) throws {
        let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(fd, F_GETPATH, &buf) == 0 else {
            let e = errno
            Darwin.close(fd)
            throw POSIXError(POSIXErrorCode(rawValue: e) ?? .EIO)
        }
        self.fd = fd
        self.path = String(cString: buf)
    }

    /// The device, filesystem id and mount point of what was opened.
    func filesystem() -> (device: dev_t, fsid: [Int32], mountedOn: String)? {
        var st = stat()
        var fs = statfs()
        guard fstat(fd, &st) == 0, fstatfs(fd, &fs) == 0 else { return nil }
        let mountedOn = withUnsafeBytes(of: &fs.f_mntonname) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        return (st.st_dev, [fs.f_fsid.val.0, fs.f_fsid.val.1], mountedOn)
    }

    func close() {
        Darwin.close(fd)
    }
}

extension POSIXError {
    var message: String { String(cString: strerror(code.rawValue)) }
}

/// A JSON integer: not a boolean, and with no fractional part.
func isInteger(_ n: NSNumber) -> Bool {
    guard CFGetTypeID(n) != CFBooleanGetTypeID() else { return false }
    return !CFNumberIsFloatType(n)
}

func lstatOf(_ path: String) -> stat? {
    var st = stat()
    return lstat(path, &st) == 0 ? st : nil
}
