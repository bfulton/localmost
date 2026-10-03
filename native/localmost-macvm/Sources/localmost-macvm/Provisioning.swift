// macOS 27's guest provisioning: VZMacGuestProvisioningOptions inside
// VZMacOSVirtualMachineStartOptions creates the account, skips Setup
// Assistant and turns Remote Login on, on the first boot after the install.
//
// The API is in the macOS 27 SDK only. Swift 6.4 is the first compiler that
// ships with it (Xcode 27), so a helper built with an older Xcode leaves it
// out, says so in `version`, and refuses `provision --display none`;
// Electron then offers the guided setup instead. At run time it also needs
// macOS 27 on the host, and a macOS 27 guest, which is what
// fetchLatestSupported gives a macOS 27 host.

import Foundation
import MacVMCore
import Virtualization

#if compiler(>=6.4)
let provisioningCompiledIn = true
#else
let provisioningCompiledIn = false
#endif

func hostSupportsProvisioning() -> Bool {
    if #available(macOS 27, *) { return provisioningCompiledIn }
    return false
}

/// The start options that provision `account`: auto-login off (the
/// bootstrap needs only SSH, and makes the job user the one logged in),
/// Remote Login on until the bootstrap turns it off.
func provisioningStartOptions(_ account: ProvisioningAccount) throws -> VZMacOSVirtualMachineStartOptions {
    let options = VZMacOSVirtualMachineStartOptions()
    #if compiler(>=6.4)
    if #available(macOS 27, *) {
        let provisioning = VZMacGuestProvisioningOptions()
        provisioning.username = account.username
        provisioning.fullName = account.fullName
        provisioning.password = account.password
        provisioning.logsInAutomatically = false
        provisioning.enablesRemoteLogin = true
        do {
            try options.setGuestProvisioning(provisioning)
        } catch {
            throw HelperError(.args, "VZ refused the provisioning options: \(describe(error))")
        }
        return options
    }
    #endif
    throw HelperError(.unsupported, "headless provisioning needs macOS 27 or later on this Mac")
}
