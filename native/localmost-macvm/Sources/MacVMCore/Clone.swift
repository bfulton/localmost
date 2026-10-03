// A VM's disk: APFS clones of a disk and its auxiliary storage - the golden
// image's, or a slot's saved one - made by the helper into the VM's own
// directory (a job VM's, or a slot's for save-state), and the slot lock that
// keeps the Mac to two macOS VMs at once.

import Darwin
import Foundation

/// The clones of one VM.
public struct VMClone: Equatable {
    public let disk: String
    public let aux: String
}

/// Clones disk.img and aux.img of a checked golden image into `vmDir`.
public func cloneGolden(_ image: CheckedImage, into vmDir: String) throws -> VMClone {
    try cloneDisks(from: image.dir, diskBytes: image.config.diskBytes, into: vmDir)
}

/// Clones disk.img and aux.img from `sourceDir` - the golden image's
/// directory or one of its slots', already checked - into `vmDir`.
///
/// clonefile(2) shares every block with the source until the guest writes
/// it, so a clone of a 100 GiB sparse disk is instant and costs nothing
/// until the VM writes. It never follows a link at either end, refuses to
/// replace anything already at the name, and works only on one APFS volume:
/// a VM directory on another volume fails here, not with a slow copy.
public func cloneDisks(from sourceDir: String, diskBytes: Int64, into vmDir: String) throws -> VMClone {
    let src: RealDirectory
    let dst: RealDirectory
    do {
        src = try RealDirectory(sourceDir)
    } catch let e as POSIXError {
        throw HelperError(.clone, "\(sourceDir) cannot be opened: \(e.message)")
    }
    defer { src.close() }
    guard src.path == sourceDir else {
        throw HelperError(.clone, "\(sourceDir) resolves to \(src.path)")
    }
    do {
        dst = try RealDirectory(vmDir)
    } catch let e as POSIXError {
        throw HelperError(.clone, "the VM directory \(vmDir) cannot be opened: \(e.message)")
    }
    defer { dst.close() }
    guard dst.path == vmDir else {
        throw HelperError(.clone, "the VM directory resolves to \(dst.path), not \(vmDir)")
    }
    var made: [String] = []
    for name in [VMFile.disk, VMFile.aux] {
        guard clonefileat(src.fd, name, dst.fd, name, UInt32(CLONE_NOFOLLOW | CLONE_NOOWNERCOPY)) == 0 else {
            let e = errno
            // What this call cloned is the helper's own: remove it. What was
            // already at a name (EEXIST) is not, and stays.
            made.forEach { unlinkat(dst.fd, $0, 0) }
            throw HelperError(.clone, "\(name) cannot be cloned into \(vmDir): \(String(cString: strerror(e)))")
        }
        made.append(name)
    }
    guard case .regular(let size) = entry(in: dst.fd, VMFile.disk), size == diskBytes else {
        made.forEach { unlinkat(dst.fd, $0, 0) }
        throw HelperError(.clone, "the clone of disk.img is not the golden disk's length")
    }
    return VMClone(disk: vmDir + "/" + VMFile.disk, aux: vmDir + "/" + VMFile.aux)
}

/// Removes a VM's clones, without following a link. Called as the helper
/// ends; Electron removes the directory itself afterwards.
public func removeClone(in vmDir: String) {
    guard let dir = try? RealDirectory(vmDir) else { return }
    defer { dir.close() }
    for name in [VMFile.disk, VMFile.aux] {
        unlinkat(dir.fd, name, 0)
    }
}

/// An exclusive lock on one of the two macOS VM slots, held for the life of
/// the process. flock(2) goes with the descriptor, so a helper that crashes
/// or is killed frees its slot at once; nothing has to clean up after it.
public final class SlotLock {
    public let slot: Int
    private var fd: Int32

    /// Takes `slot`'s lock under `<data>/macos-vm/slots`, or fails at once
    /// with E_SLOT when another helper holds it.
    public init(layout: Layout, slot: Int) throws {
        guard macVMSlots.contains(slot) else {
            throw HelperError(.slot, "slot \(slot) is not one of the two macOS VM slots")
        }
        let slotsDir: RealDirectory
        do {
            slotsDir = try RealDirectory(layout.slots)
        } catch let e as POSIXError {
            throw HelperError(.slot, "the slots directory \(layout.slots) cannot be opened: \(e.message)")
        }
        defer { slotsDir.close() }
        guard slotsDir.path == layout.slots else {
            throw HelperError(.slot, "the slots directory resolves to \(slotsDir.path)")
        }
        let fd = openat(slotsDir.fd, "\(slot).lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else {
            throw HelperError(.slot, "slot \(slot)'s lock cannot be opened: \(posixMessage())")
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let e = errno
            close(fd)
            if e == EWOULDBLOCK {
                throw HelperError(.slot, "macOS VM slot \(slot) is in use by another VM")
            }
            throw HelperError(.slot, "slot \(slot)'s lock cannot be taken: \(String(cString: strerror(e)))")
        }
        self.slot = slot
        self.fd = fd
    }

    public func release() {
        guard fd >= 0 else { return }
        close(fd)
        fd = -1
    }

    deinit {
        release()
    }
}
