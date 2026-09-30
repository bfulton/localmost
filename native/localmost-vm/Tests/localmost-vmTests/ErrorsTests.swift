import Foundation
import XCTest
@testable import localmost_vm

/// The exit-code table of contract §2.4, which HelperClient maps back to
/// VmError.code. A change here is a contract change.
final class ErrorsTests: XCTestCase {
    func testEveryCodeExitsWithItsContractNumber() {
        let table: [(ErrorCode, String, Int32)] = [
            (.args, "E_ARGS", 64),
            (.share, "E_SHARE", 65),
            (.guestImage, "E_GUEST_IMAGE", 66),
            (.disk, "E_DISK", 67),
            (.vzConfig, "E_VZ_CONFIG", 68),
            (.vzStart, "E_VZ_START", 69),
            (.socket, "E_SOCKET", 70),
            (.guestError, "E_GUEST_ERROR", 71),
            (.sync, "E_SYNC", 72),
        ]
        XCTAssertEqual(ErrorCode.allCases.count, table.count, "a code outside the contract's table")
        for (code, name, exit) in table {
            XCTAssertEqual(code.rawValue, name)
            XCTAssertEqual(code.exitCode, exit, name)
        }
    }

    func testACleanStopExitsZero() {
        XCTAssertEqual(cleanExitCode, 0)
    }

    func testTheCodesAreDistinct() {
        XCTAssertEqual(Set(ErrorCode.allCases.map(\.exitCode)).count, ErrorCode.allCases.count)
    }

    func testAnErrorIsDescribedWithTheErrorsUnderIt() {
        let posix = NSError(domain: NSPOSIXErrorDomain, code: Int(EPERM), userInfo: [NSLocalizedDescriptionKey: "Operation not permitted"])
        let vz = NSError(domain: "VZErrorDomain", code: 2, userInfo: [NSLocalizedDescriptionKey: "A directory sharing device configuration is invalid.",
                                                                       NSUnderlyingErrorKey: posix])
        XCTAssertEqual(describe(vz), "A directory sharing device configuration is invalid. (VZErrorDomain 2) <- Operation not permitted (NSPOSIXErrorDomain 1)")
    }

    func testAHelperErrorDescribesItselfByCodeAndMessage() {
        let e = HelperError(.share, "the share is a symbolic link")
        XCTAssertEqual(e.code, .share)
        XCTAssertEqual(e.description, "E_SHARE: the share is a symbolic link")
    }
}
