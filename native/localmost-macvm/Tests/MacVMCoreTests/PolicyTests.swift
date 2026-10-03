import XCTest
@testable import MacVMCore

/// The small rules: the catalog's allowlist, the provisioning account, the
/// job's identity, the guided steps, the agent's hello, the error table.
final class PolicyTests: XCTestCase {
    func testOnlyApplesRestoreImageHostIsAllowed() {
        let ok = "https://updates.cdn-apple.com/2026SummerFCS/fullrestores/140-75212/A2A24B94/UniversalMac_26.6.2_25G83_Restore.ipsw"
        XCTAssertTrue(isAllowedRestoreImageURL(URL(string: ok)!))
        for bad in [
            "http://updates.cdn-apple.com/x/r.ipsw",
            "https://updates.cdn-apple.com.evil.example/x/r.ipsw",
            "https://evil.example/updates.cdn-apple.com/r.ipsw",
            "https://updates.cdn-apple.com:8443/x/r.ipsw",
            "https://user@updates.cdn-apple.com/x/r.ipsw",
            "https://updates.cdn-apple.com/x/r.ipsw?redirect=1",
            "https://updates.cdn-apple.com/x/r.zip",
            "file:///tmp/r.ipsw",
        ] {
            XCTAssertFalse(isAllowedRestoreImageURL(URL(string: bad)!), bad)
        }
    }

    func testTheProvisioningAccountIsCheckedFieldByField() throws {
        let good: [String: Any] = ["username": "localmost-admin", "fullName": "localmost setup", "password": "abcd-efgh-jkmn-pqrs"]
        let account = try ProvisioningAccount(good)
        XCTAssertEqual(account.username, "localmost-admin")
        for (key, value) in [("username", "Admin"), ("username", "1admin"), ("username", "a b"), ("username", String(repeating: "a", count: 32)),
                             ("fullName", ""), ("fullName", "tab\there"), ("password", "short"), ("password", "has a space in it ok"),
                             ("password", "ünïcode-password-x")] {
            var o = good
            o[key] = value
            XCTAssertThrowsError(try ProvisioningAccount(o), "\(key)=\(value)") { XCTAssertEqual(($0 as? HelperError)?.code, .args) }
        }
        var missing = good
        missing["password"] = nil
        XCTAssertThrowsError(try ProvisioningAccount(missing))
    }

    func testJobsPresentTheGoldenIdentitySoTheStateRestores() {
        XCTAssertEqual(jobMachineIdentity, .golden)
        XCTAssertEqual(jobMachineIdentifier(golden: Data([1]), fresh: { XCTFail("not asked"); return Data() }), Data([1]))
        XCTAssertEqual(jobMachineIdentifier(golden: Data([1]), fresh: { Data([2]) }, identity: .fresh), Data([2]))
    }

    func testTheGuidedStepsCarryTheAccountsValues() throws {
        let account = try ProvisioningAccount(["username": "localmost-admin", "fullName": "localmost setup", "password": "abcd-efgh-jkmn-pqrs"])
        let steps = guidedSetupSteps(account).joined(separator: "\n")
        XCTAssertTrue(steps.contains("Account name: localmost-admin"))
        XCTAssertTrue(steps.contains("Password: abcd-efgh-jkmn-pqrs"))
        XCTAssertTrue(steps.contains("Full name: localmost setup"))
        XCTAssertTrue(steps.contains("Remote Login"))
    }

    func testTheAgentIsReadyOnlyWhenItsHelloSaysSo() {
        XCTAssertTrue(isReadyHello(Data(#"{"v":1,"event":"hello","ready":true}"#.utf8)))
        XCTAssertFalse(isReadyHello(Data(#"{"v":1,"event":"hello","ready":false}"#.utf8)))
        XCTAssertFalse(isReadyHello(Data(#"{"v":1,"event":"hello","ready":1}"#.utf8)))
        XCTAssertFalse(isReadyHello(Data(#"{"v":1,"event":"exit","ready":true}"#.utf8)))
        XCTAssertFalse(isReadyHello(Data(#"{"event":"hello","ready":true}"#.utf8)))
    }

    func testEveryErrorHasItsOwnExitCode() {
        let codes = ErrorCode.allCases.map { $0.exitCode }
        XCTAssertEqual(Set(codes).count, codes.count)
        XCTAssertFalse(codes.contains(cleanExitCode))
        XCTAssertEqual(ErrorCode.args.exitCode, 64)
        XCTAssertEqual(ErrorCode.catalog.exitCode, 76)
    }
}
