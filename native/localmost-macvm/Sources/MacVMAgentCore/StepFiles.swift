// The files the agent, root, hands a test run's job user: an upload on its
// way to being unpacked, a step's script, and the step's GITHUB_OUTPUT,
// which the agent reads back once the step exits. They live in a directory
// of root's (stepScratchDir), so the job user can read or write each file
// it is given but never put a link or a FIFO where the agent writes or reads.

import Darwin
import Foundation
import MacVMCore

/// A new file in `dir` under a random name, created there and nowhere else
/// (no link followed, nothing already at the name), then given to `uid` with
/// `mode`. `dir` is made if it is missing, and must be a directory of
/// `owner`'s that nobody else can write.
public func scratchFile(in dir: String, owner: uid_t, _ prefix: String, contents: Data, uid: uid_t, gid: gid_t,
                        mode: mode_t) throws -> String {
    if mkdir(dir, 0o711) != 0, errno != EEXIST {
        throw ProtocolError("\(dir) cannot be made: \(posixMessage())")
    }
    var st = stat()
    guard lstat(dir, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == owner, st.st_mode & 0o022 == 0 else {
        throw ProtocolError("\(dir) is not a directory only its owner can write")
    }
    let name = (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    let path = "\(dir)/\(prefix)-\(name)"
    let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw ProtocolError("\(path) cannot be made: \(posixMessage())") }
    defer { close(fd) }
    guard writeAll(fd, contents), fchown(fd, uid, gid) == 0, fchmod(fd, mode) == 0 else {
        let message = posixMessage()
        unlink(path)
        throw ProtocolError("\(path) cannot be written: \(message)")
    }
    return path
}

/// What a step wrote to GITHUB_OUTPUT: read only from a regular file, never
/// through a link or by waiting on a FIFO, and only up to
/// maxStepOutputsBytes; more is dropped, with a line that says so.
public func readStepOutputs(_ path: String, onDropped: (String) -> Void) -> String {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { return "" }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { return "" }
    guard st.st_size <= maxStepOutputsBytes else {
        onDropped("localmost: this step's GITHUB_OUTPUT is over \(maxStepOutputsBytes / 1024) KiB, so its outputs were dropped")
        return ""
    }
    var buf = [UInt8](repeating: 0, count: maxStepOutputsBytes + 1)
    let n = read(fd, &buf, buf.count)
    guard n > 0, n <= maxStepOutputsBytes else { return "" }
    return String(decoding: buf[0..<n], as: UTF8.self)
}
