// What the helper itself needs of the guest agent's protocol: whether the
// line it greets a connection with says it is ready. The rest of the
// protocol is between Electron and the agent (MacVMAgentCore, and
// src/main/isolation/macos-vm/agent-client.ts); the helper only relays it.

import Foundation

/// The guest agent's version this helper was built with.
public let agentVersion = "1.0.0"

/// Whether `line` is the agent's hello and says it is ready: its services
/// are up and nothing of a job has reached the guest. save-state takes the
/// golden state only then.
public func isReadyHello(_ line: Data) -> Bool {
    guard let object = decodeLine(line), object["event"] as? String == "hello" else { return false }
    return isJSONTrue(object["ready"])
}

/// Whether a decoded JSON value is the literal `true`. `as? Bool` alone also
/// takes the number 1, which Foundation bridges to true.
public func isJSONTrue(_ value: Any?) -> Bool {
    guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return false }
    return n.boolValue
}

/// How often save-state asks the agent whether it is ready, and for how
/// long: a first boot after provisioning finishes its own setup first.
public let agentPollMs = 3000
public let agentReadyTimeoutMs = 15 * 60 * 1000
