// The helper's error codes and exit codes. Electron's MacVmHelper maps the
// exit code back to the code (src/main/isolation/macos-vm/helper-client.ts),
// so this table is part of the helper's contract with it: a change here is a
// change on both sides.

/// Every way the helper fails, each with its own exit code.
public enum ErrorCode: String, CaseIterable {
    /// A bad or missing argument, or a path derived from one that is not there.
    case args = "E_ARGS"
    /// The golden image is missing, incomplete, or not what its config says.
    case image = "E_IMAGE"
    /// The restore image cannot be read, or this Mac cannot install it.
    case ipsw = "E_IPSW"
    /// VZMacOSInstaller failed.
    case install = "E_INSTALL"
    /// The configuration did not validate.
    case vzConfig = "E_VZ_CONFIG"
    /// The VM did not start.
    case vzStart = "E_VZ_START"
    /// A unix socket could not be bound.
    case socket = "E_SOCKET"
    /// VZ stopped the VM with an error.
    case guestError = "E_GUEST_ERROR"
    /// Both macOS VM slots are taken, or this slot is.
    case slot = "E_SLOT"
    /// A clone of the golden image could not be made.
    case clone = "E_CLONE"
    /// The machine state could not be saved.
    case state = "E_STATE"
    /// This Mac cannot do what was asked: provisioning before macOS 27, say.
    case unsupported = "E_UNSUPPORTED"
    /// The restore image catalog could not be fetched, or named a URL off the allowlist.
    case catalog = "E_CATALOG"

    public var exitCode: Int32 {
        switch self {
        case .args: return 64
        case .image: return 65
        case .ipsw: return 66
        case .install: return 67
        case .vzConfig: return 68
        case .vzStart: return 69
        case .socket: return 70
        case .guestError: return 71
        case .slot: return 72
        case .clone: return 73
        case .state: return 74
        case .unsupported: return 75
        case .catalog: return 76
        }
    }
}

/// The exit code of a clean end: the guest powered off, a stop was asked
/// for, or a one-shot command finished.
public let cleanExitCode: Int32 = 0

/// The code a command answer carries when the command itself is malformed or
/// unknown. Never an exit code: a bad command is refused, not fatal.
public let protocolErrorCode = "E_PROTO"

/// A failure that ends the helper: reported in its last event, logged, and exited with.
public struct HelperError: Error, CustomStringConvertible, Equatable {
    public let code: ErrorCode
    public let message: String

    public init(_ code: ErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }

    public var description: String { "\(code.rawValue): \(message)" }
}
