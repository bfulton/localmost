import Foundation
import XCTest

/// A fresh directory under the test's TMPDIR, removed afterwards. Its path is
/// the one the caller would pass, not yet realpathed (under /var, which is a
/// link to /private/var), so the tests see the helper resolve it.
final class TempDir {
    let path: String

    init(_ name: String = #function) throws {
        let base = NSTemporaryDirectory() as NSString
        let tag = name.filter { $0.isLetter || $0.isNumber }.prefix(24)
        path = base.appendingPathComponent("lmvm-\(tag)-\(UUID().uuidString.prefix(8))")
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
    func write(_ rel: String, _ bytes: Int) throws -> String {
        try write(rel, Data(repeating: 0x41, count: bytes))
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
        (try? realPath(path)) ?? path
    }

    deinit {
        try? FileManager.default.removeItem(atPath: path)
    }
}

/// Runs a program to completion and returns its status and output.
@discardableResult
func run(_ exe: String, _ args: [String]) throws -> (status: Int32, output: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    try p.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: data, as: UTF8.self))
}

func realPath(_ p: String) throws -> String {
    guard let r = realpath(p, nil) else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    defer { free(r) }
    return String(cString: r)
}
