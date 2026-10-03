// The framing the helper's stdio and the guest agent's control connection
// share: UTF-8 JSON, one object per line, at most 64 KiB a line, each object
// stamped `"v":1` - the same framing as localmost-vm's (src/main/vm/ndjson.ts
// is the Electron side of both).

import Foundation

/// The most one line may hold, newline excluded: 64 KiB.
public let maxLineBytes = 64 << 10

/// The protocol version every object carries.
public let protocolVersion = 1

/// The most a message in an event may hold, so that every event fits one line.
public let maxMessageBytes = 2048

/// Splits a byte stream into lines. A line over the cap is reported once as
/// `oversize` and the rest of it, up to its newline, is dropped as it arrives,
/// so the buffer never grows much past the cap.
public struct LineReader {
    public enum Item: Equatable {
        case line(Data)
        case oversize
    }

    private var buffer = Data()
    private var discarding = false

    public init() {}

    public var buffered: Int { buffer.count }

    public mutating func feed(_ data: Data) -> [Item] {
        var items: [Item] = []
        var rest = data[...]
        while let newline = rest.firstIndex(of: UInt8(ascii: "\n")) {
            let piece = rest[rest.startIndex..<newline]
            rest = rest[rest.index(after: newline)...]
            if discarding {
                discarding = false
                buffer.removeAll(keepingCapacity: true)
                continue
            }
            if buffer.count + piece.count > maxLineBytes {
                items.append(.oversize)
            } else {
                items.append(.line(buffer + piece))
            }
            buffer.removeAll(keepingCapacity: true)
        }
        if !discarding {
            if buffer.count + rest.count > maxLineBytes {
                items.append(.oversize)
                discarding = true
                buffer.removeAll(keepingCapacity: true)
            } else {
                buffer.append(contentsOf: rest)
            }
        }
        return items
    }
}

/// One object as a line: `"v":1` added, keys sorted, newline included. Nil
/// only when a value is not JSON, which is a bug in the caller.
public func encodeLine(_ fields: [String: Any]) -> Data? {
    var object = fields
    object["v"] = protocolVersion
    guard var line = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) else {
        return nil
    }
    line.append(UInt8(ascii: "\n"))
    return line.count <= maxLineBytes + 1 ? line : nil
}

/// A line as an object with `"v":1`, or nil.
public func decodeLine(_ data: Data) -> [String: Any]? {
    guard let object = try? JSONSerialization.jsonObject(with: data), let dict = object as? [String: Any],
          let v = dict["v"] as? NSNumber, isInteger(v), v.intValue == protocolVersion
    else { return nil }
    return dict
}

/// A JSON integer: not a boolean, and with no fractional part.
public func isInteger(_ n: NSNumber) -> Bool {
    guard CFGetTypeID(n) != CFBooleanGetTypeID() else { return false }
    return !CFNumberIsFloatType(n)
}

/// A message cut to fit an event, on a character boundary.
public func bounded(_ message: String) -> String {
    guard message.utf8.count > maxMessageBytes else { return message }
    var out = ""
    for c in message {
        if out.utf8.count + String(c).utf8.count > maxMessageBytes - 3 { break }
        out.append(c)
    }
    return out + "..."
}

/// An error as one line: its description, domain and code, and those of the
/// errors under it.
public func describe(_ error: Error) -> String {
    if let e = error as? HelperError { return e.message }
    var parts: [String] = []
    var next: NSError? = error as NSError
    while let ns = next, parts.count < 4 {
        parts.append("\(ns.localizedDescription) (\(ns.domain) \(ns.code))")
        next = ns.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return parts.joined(separator: " <- ")
}
