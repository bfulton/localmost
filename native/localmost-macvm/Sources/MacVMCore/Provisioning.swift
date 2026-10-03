// The account the golden image's one-time setup creates, as Electron sends
// it on stdin, and the identity each job VM presents.

import Foundation

/// The administrator account the setup creates, used only by the bootstrap
/// over SSH and given a password nobody keeps once the bootstrap is done
/// (docs/roadmap/macos-vm-jobs.md, "Accounts").
public struct ProvisioningAccount: Equatable {
    public let username: String
    public let fullName: String
    public let password: String

    /// From a `provision` or `guide` command: each field in its form, or E_ARGS.
    public init(_ object: [String: Any]) throws {
        guard let username = object["username"] as? String, isAccountName(username) else {
            throw HelperError(.args, "the account's username must be 1-31 of a-z, 0-9, _ and -, starting with a letter")
        }
        guard let fullName = object["fullName"] as? String, !fullName.isEmpty, fullName.count <= 64,
              fullName.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value < 0x7f })
        else {
            throw HelperError(.args, "the account's full name must be 1-64 printable ASCII characters")
        }
        guard let password = object["password"] as? String, (16...128).contains(password.count),
              password.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value < 0x7f })
        else {
            throw HelperError(.args, "the account's password must be 16-128 printable ASCII characters with no spaces")
        }
        self.username = username
        self.fullName = fullName
        self.password = password
    }
}

/// `^[a-z][a-z0-9_-]{0,30}$`: a short macOS account name.
public func isAccountName(_ s: String) -> Bool {
    let bytes = Array(s.utf8)
    guard (1...31).contains(bytes.count), bytes[0] >= UInt8(ascii: "a"), bytes[0] <= UInt8(ascii: "z") else { return false }
    return bytes.allSatisfy { c in
        (c >= UInt8(ascii: "a") && c <= UInt8(ascii: "z")) || isDigit(c) || c == UInt8(ascii: "_") || c == UInt8(ascii: "-")
    }
}

/// Which machine identifier a job VM presents.
public enum MachineIdentity: Equatable {
    /// The golden image's own, which its saved state was taken with.
    case golden
    /// A new one for every VM.
    case fresh
}

/// The identity every job VM presents (docs/roadmap/macos-vm-jobs.md,
/// "Machine identifier"): the golden image's, so that its saved state
/// restores, and so that the guest sees the machine it was installed on.
public let jobMachineIdentity = MachineIdentity.golden

/// The machine identifier's data for a job VM, by `jobMachineIdentity`.
public func jobMachineIdentifier(golden: Data, fresh: () -> Data, identity: MachineIdentity = jobMachineIdentity) -> Data {
    switch identity {
    case .golden: return golden
    case .fresh: return fresh()
    }
}
