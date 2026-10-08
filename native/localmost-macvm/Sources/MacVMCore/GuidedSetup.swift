// What the guided setup's window asks the operator to do in the VM, on a
// Mac older than macOS 27 where VZ cannot provision the guest itself. The
// window shows these beside the VM; Electron shows the same in Settings.

/// The steps, in order, with the account's values filled in.
public func guidedSetupSteps(_ account: ProvisioningAccount) -> [String] {
    [
        "Pick a language and a country or region. At Migration Assistant, choose Not Now.",
        "At Apple Account, choose Set Up Later, then Skip. The VM needs no Apple Account.",
        "Create the computer account exactly as follows. Full name: \(account.fullName). Account name: \(account.username). Password: \(account.password) (type it in both fields; leave the hint empty).",
        "Turn off Location Services, analytics, Screen Time and Siri; any appearance will do.",
        "At the desktop, open System Settings, then General, then Sharing, and turn on Remote Login.",
        "Leave this window open. localmost connects over Remote Login, finishes the setup on its own, turns Remote Login off again and shuts the VM down; the window then closes.",
    ]
}
