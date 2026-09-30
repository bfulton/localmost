// The guest's serial console, kept in console.log for diagnosis (contract
// §2.2). The guest writes what it likes there, so the file is capped: past
// 2 MiB it is cut to its last 1 MiB.

import Foundation

final class ConsoleLog {
    static let defaultLimit = 2 << 20
    static let defaultKeep = 1 << 20

    private let fd: Int32
    private let limit: Int
    private let keep: Int
    private var size: Int
    private let lock = NSLock()

    /// Opens (or creates, owner-only) the log. A link at the path is refused.
    init(path: String, limit: Int = defaultLimit, keep: Int = defaultKeep) throws {
        fd = open(path, O_RDWR | O_CREAT | O_APPEND | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else {
            throw HelperError(.vzConfig, "console log \(path): \(posixMessage())")
        }
        var st = stat()
        guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG else {
            close(fd)
            throw HelperError(.vzConfig, "console log \(path) is not a regular file")
        }
        _ = fchmod(fd, 0o600)
        self.limit = limit
        self.keep = keep
        size = Int(st.st_size)
    }

    deinit {
        close(fd)
    }

    func append(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        data.withUnsafeBytes { raw in
            var off = 0
            while off < raw.count {
                let n = write(fd, raw.baseAddress! + off, raw.count - off)
                if n < 0, errno == EINTR { continue }
                if n <= 0 { return }
                off += n
                size += n
            }
        }
        if size > limit { cut() }
    }

    /// Keeps the last `keep` bytes.
    private func cut() {
        var tail = [UInt8](repeating: 0, count: keep)
        let n = pread(fd, &tail, keep, off_t(size - keep))
        guard n > 0, ftruncate(fd, 0) == 0 else { return }
        size = 0
        var off = 0
        while off < n {
            let w = tail.withUnsafeBytes { write(fd, $0.baseAddress! + off, n - off) }
            if w < 0, errno == EINTR { continue }
            if w <= 0 { break }
            off += w
            size += w
        }
    }
}
