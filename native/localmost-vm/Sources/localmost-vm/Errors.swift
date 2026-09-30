// The helper's error codes and exit codes (contract §2.4). Electron's
// HelperClient maps the exit code back to VmError.code, so this table is
// part of the contract: a change here changes the contract.

/// Every way the helper fails, each with its own exit code.
enum ErrorCode: String, CaseIterable {
    /// A bad or missing argument, or a path derived from one that is not there.
    case args = "E_ARGS"
    /// The share failed a §2.1 check.
    case share = "E_SHARE"
    /// A guest artifact is missing or the wrong size.
    case guestImage = "E_GUEST_IMAGE"
    /// The data disk is missing or cannot be attached.
    case disk = "E_DISK"
    /// `validate()` failed.
    case vzConfig = "E_VZ_CONFIG"
    /// `start` failed, including EPERM from the helper's own sandbox.
    case vzStart = "E_VZ_START"
    /// A unix socket could not be bound.
    case socket = "E_SOCKET"
    /// VZ reported `didStopWithError`.
    case guestError = "E_GUEST_ERROR"
    /// `F_FULLFSYNC` of the data disk failed after a refresh.
    case sync = "E_SYNC"

    var exitCode: Int32 {
        switch self {
        case .args: return 64
        case .share: return 65
        case .guestImage: return 66
        case .disk: return 67
        case .vzConfig: return 68
        case .vzStart: return 69
        case .socket: return 70
        case .guestError: return 71
        case .sync: return 72
        }
    }
}

/// The exit code of a clean stop: the guest powered off, or a stop was requested.
let cleanExitCode: Int32 = 0

/// The code a command answer carries when the command itself is malformed or
/// unknown. It is never an exit code: a bad command is refused, not fatal.
let protocolErrorCode = "E_PROTO"

/// A failure that ends the helper: reported in `stopped`, logged, and exited with.
struct HelperError: Error, CustomStringConvertible {
    let code: ErrorCode
    let message: String

    init(_ code: ErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }

    var description: String { "\(code.rawValue): \(message)" }
}
