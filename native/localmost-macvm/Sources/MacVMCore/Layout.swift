// Every path the helper uses, derived from `--data-dir` and the ids:
//
//   <data>/macos-vm/ipsw/<name>.ipsw           restore images Electron downloaded
//   <data>/macos-vm/images/<imageId>/          one golden image
//       disk.img aux.img config.json           written by `install`, booted only by `provision`
//       slot<1|2>/                             one slot's saved state, written by `save-state`:
//           disk.img aux.img                   clones of the golden files, booted with the slot's identity
//           state.vzvmsave state.json          the state saved over them, and its stamp
//   <data>/macos-vm/vms/<vmId>/                one job VM
//       disk.img aux.img                       the helper's clones of the golden or slot files
//       agent.sock helper.pid                  its socket and pid file
//   <data>/macos-vm/slots/<1|2>.lock           held by whichever helper runs a VM in that slot
//
// Electron makes the image, slot and VM directories before it spawns the
// helper; the helper makes none of them and follows no link to them. Each is
// opened with O_NOFOLLOW and its real path read back with F_GETPATH, never
// walked with realpath(3): under the helper's deny-default profile a walk
// fails, because it reads the metadata of `<data>`'s ancestors, which the
// profile does not grant.

import Darwin
import Foundation

public enum GoldenFile {
    public static let disk = "disk.img"
    public static let aux = "aux.img"
    public static let config = "config.json"
}

/// A slot's saved state, in `<image>/slot<n>`.
public enum SlotFile {
    public static let disk = "disk.img"
    public static let aux = "aux.img"
    public static let state = "state.vzvmsave"
    public static let stateStamp = "state.json"
}

public enum VMFile {
    public static let disk = "disk.img"
    public static let aux = "aux.img"
    public static let agentSocket = "agent.sock"
    public static let pidFile = "helper.pid"
}

/// The real directories of one command, resolved once.
public struct Layout {
    /// `<data>`, real.
    public let dataDir: String

    public var root: String { dataDir + "/macos-vm" }
    public func image(_ imageId: String) -> String { root + "/images/" + imageId }
    public func vm(_ vmId: String) -> String { root + "/vms/" + vmId }
    public var slots: String { root + "/slots" }
    public func slotLock(_ slot: Int) -> String { slots + "/\(slot).lock" }

    public init(realDataDir: String) {
        dataDir = realDataDir
    }

    /// Opens `<data>/<suffix>` and reads its real path, which gives the real
    /// `<data>`. A missing directory, or a link anywhere from `<data>` down
    /// to it, is an argument error: the helper creates none of these.
    public static func resolving(dataDir: String, through suffix: String) throws -> (layout: Layout, dir: String) {
        let given = dataDir + suffix
        let real: String
        do {
            let dir = try RealDirectory(given)
            real = dir.path
            dir.close()
        } catch let e as POSIXError {
            throw HelperError(.args, "\(given) cannot be opened: \(e.message)")
        }
        guard real.hasSuffix(suffix) else {
            throw HelperError(.args, "\(given) resolves to \(real)")
        }
        return (Layout(realDataDir: String(real.dropLast(suffix.count))), real)
    }

    /// The layout for a golden image's own directory.
    public static func forImage(dataDir: String, imageId: String) throws -> (layout: Layout, imageDir: String) {
        let r = try resolving(dataDir: dataDir, through: "/macos-vm/images/" + imageId)
        return (r.layout, r.dir)
    }

    /// The layout for a job VM's own directory.
    public static func forVM(dataDir: String, vmId: String) throws -> (layout: Layout, vmDir: String) {
        let r = try resolving(dataDir: dataDir, through: "/macos-vm/vms/" + vmId)
        return (r.layout, r.dir)
    }
}

// MARK: - Files

/// What is at a name in a directory, without following a link.
public enum Entry: Equatable {
    case missing
    case regular(size: Int64)
    case other
}

public func entry(in dirfd: Int32, _ name: String) -> Entry {
    var st = stat()
    guard fstatat(dirfd, name, &st, AT_SYMLINK_NOFOLLOW) == 0 else {
        return errno == ENOENT ? .missing : .other
    }
    return st.st_mode & S_IFMT == S_IFREG ? .regular(size: Int64(st.st_size)) : .other
}

/// Reads a small regular file in a directory, refusing a link and anything
/// over `max` bytes.
public func readSmallFile(in dirfd: Int32, _ name: String, max: Int) throws -> Data {
    let fd = openat(dirfd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG else {
        throw POSIXError(.EFTYPE)
    }
    var data = Data()
    var buf = [UInt8](repeating: 0, count: 64 << 10)
    while true {
        let n = read(fd, &buf, buf.count)
        if n < 0 {
            if errno == EINTR { continue }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        if n == 0 { break }
        data.append(buf, count: n)
        if data.count > max {
            throw POSIXError(.EFBIG)
        }
    }
    return data
}

/// Writes a file in a directory atomically: a new temporary file, created
/// exclusively, synced, then renamed over the name. Nothing at the name is
/// followed.
public func writeFileAtomically(in dirfd: Int32, _ name: String, _ data: Data, mode: mode_t = 0o600) throws {
    let tmp = ".\(name).\(getpid()).tmp"
    unlinkat(dirfd, tmp, 0)
    let fd = openat(dirfd, tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
    guard fd >= 0 else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    let ok = writeAll(fd, data) && fsync(fd) == 0
    let e = errno
    close(fd)
    guard ok else {
        unlinkat(dirfd, tmp, 0)
        throw POSIXError(POSIXErrorCode(rawValue: e) ?? .EIO)
    }
    guard renameat(dirfd, tmp, dirfd, name) == 0 else {
        let e = errno
        unlinkat(dirfd, tmp, 0)
        throw POSIXError(POSIXErrorCode(rawValue: e) ?? .EIO)
    }
}

/// `helper.pid`: the helper's pid and a newline, for Electron's startup sweep.
public func writePidFile(_ path: String) throws {
    let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else {
        throw HelperError(.args, "\(path): \(posixMessage())")
    }
    defer { close(fd) }
    guard writeAll(fd, Data("\(getpid())\n".utf8)) else {
        throw HelperError(.args, "\(path): \(posixMessage())")
    }
}

/// Writes every byte, or reports that it could not.
@discardableResult
public func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { raw in
        var off = 0
        while off < raw.count {
            let n = write(fd, raw.baseAddress! + off, raw.count - off)
            if n < 0, errno == EINTR { continue }
            if n <= 0 { return false }
            off += n
        }
        return true
    }
}

// MARK: - Helpers

/// A directory opened with O_NOFOLLOW, and its real path as the kernel knows it.
public struct RealDirectory {
    public let fd: Int32
    public let path: String

    public init(_ path: String) throws {
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

    /// The device and filesystem id of what was opened.
    public func device() -> (device: dev_t, fsid: [Int32])? {
        var st = stat()
        var fs = statfs()
        guard fstat(fd, &st) == 0, fstatfs(fd, &fs) == 0 else { return nil }
        return (st.st_dev, [fs.f_fsid.val.0, fs.f_fsid.val.1])
    }

    public func close() {
        Darwin.close(fd)
    }
}

extension POSIXError {
    public var message: String { String(cString: strerror(code.rawValue)) }
}

public func posixMessage() -> String {
    String(cString: strerror(errno))
}
