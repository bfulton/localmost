import Foundation
import XCTest
@testable import MacVMCore

/// A fresh directory under the test's TMPDIR, removed afterwards. Its path is
/// the one the caller would pass, not yet realpathed (under /var, which is a
/// link to /private/var), so the tests see the helper resolve it.
final class TempDir {
    let path: String

    init(_ name: String = #function) throws {
        let base = NSTemporaryDirectory() as NSString
        let tag = name.filter { $0.isLetter || $0.isNumber }.prefix(24)
        path = base.appendingPathComponent("lmmac-\(tag)-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }

    func sub(_ rel: String) -> String {
        (path as NSString).appendingPathComponent(rel)
    }

    @discardableResult
    func mkdir(_ rel: String) throws -> String {
        let p = sub(rel)
        try FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
        return p
    }

    @discardableResult
    func write(_ rel: String, _ data: Data) throws -> String {
        let p = sub(rel)
        try FileManager.default.createDirectory(atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        guard FileManager.default.createFile(atPath: p, contents: data) else {
            throw NSError(domain: "TempDir", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot write \(p)"])
        }
        return p
    }

    func symlink(_ rel: String, to target: String) throws {
        try FileManager.default.createSymbolicLink(atPath: sub(rel), withDestinationPath: target)
    }

    var real: String {
        guard let r = realpath(path, nil) else { return path }
        defer { free(r) }
        return String(cString: r)
    }

    deinit {
        try? FileManager.default.removeItem(atPath: path)
    }
}

/// What a command sent and how it ended, through Hooks.
final class Recorder {
    var events: [[String: Any]] = []
    var logs: [String] = []
    var exitCode: Int32?

    lazy var hooks = Hooks(
        emit: { [unowned self] line in
            XCTAssertEqual(line.last, UInt8(ascii: "\n"))
            self.events.append(decodeLine(line.dropLast()) ?? ["undecodable": true])
        },
        log: { [unowned self] level, message in self.logs.append("\(level) \(message)") },
        finish: { [unowned self] code in
            XCTAssertNil(self.exitCode, "finish is called exactly once")
            self.exitCode = code
        }
    )

    var last: [String: Any] { events.last ?? [:] }
    func named(_ event: String) -> [[String: Any]] { events.filter { $0["event"] as? String == event } }
}

/// A golden image's files, as `install` leaves them, with its two slot
/// directories (Electron makes them), and a saved state in each slot of `states`.
func makeImage(_ tmp: TempDir, id: String = "a1b2c3d4e5f6", diskBytes: Int64 = 1 << 20, states: [Int] = []) throws -> String {
    let dir = try tmp.mkdir("data/macos-vm/images/\(id)")
    let config = ImageConfig(imageId: id, build: "25G83", os: "26.6.2", hardwareModel: Data([1, 2, 3]),
                             machineIdentifiers: [Data([4, 5, 6]), Data([7, 8, 9])], diskBytes: diskBytes,
                             macAddress: "02:11:22:33:44:55", minCpus: 2, minMemoryBytes: 4 << 30)
    try tmp.write("data/macos-vm/images/\(id)/config.json", try config.encoded())
    try makeSparse(dir + "/disk.img", bytes: diskBytes)
    try tmp.write("data/macos-vm/images/\(id)/aux.img", Data(repeating: 7, count: 4096))
    for slot in macVMSlots {
        try tmp.mkdir("data/macos-vm/images/\(id)/slot\(slot)")
    }
    for slot in states {
        let s = "data/macos-vm/images/\(id)/slot\(slot)"
        try makeSparse(tmp.sub(s + "/disk.img"), bytes: diskBytes)
        try tmp.write(s + "/aux.img", Data(repeating: 7, count: 4096))
        try tmp.write(s + "/state.vzvmsave", Data(repeating: 9, count: 1024))
        let stamp = StateStamp(slot: slot, hostBuild: "25G83", helperVersion: "1.0.0", cpus: 4, memoryMiB: 6144)
        try tmp.write(s + "/state.json", try JSONEncoder().encode(stamp))
    }
    return dir
}

/// A sparse file of `bytes`.
func makeSparse(_ path: String, bytes: Int64) throws {
    XCTAssertTrue(FileManager.default.createFile(atPath: path, contents: nil))
    let fh = FileHandle(forWritingAtPath: path)!
    try fh.truncate(atOffset: UInt64(bytes))
    try fh.close()
}
