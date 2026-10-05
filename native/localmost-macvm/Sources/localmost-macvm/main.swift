// localmost-macvm: builds localmost's golden macOS image and runs one macOS
// VM per job, under a seatbelt profile Electron writes for each command, and
// speaks NDJSON on stdio (docs/roadmap/macos-vm-jobs.md, "The helper").
//
//   localmost-macvm version | catalog
//   localmost-macvm inspect --ipsw <path>
//   localmost-macvm install --data-dir <d> --image-id <id> --ipsw <path> --disk-gib <n> --slot <1|2>
//   localmost-macvm provision --data-dir <d> --image-id <id> --slot <1|2> --display none|window
//   localmost-macvm save-state --data-dir <d> --image-id <id> --slot <1|2> --cpus <n> --memory-mib <n>
//   localmost-macvm run --data-dir <d> --image-id <id> --vm-id <1|2>-<hex> --proxy-port <p> --broker-port <p>
//                       --cpus <n> --memory-mib <n> --boot restore|cold
//   localmost-macvm check --data-dir <d> --image-id <id>
//
// Everything it touches is derived from its arguments; nothing on its command
// line is a path a job chose, and no secret is ever on it.

import Foundation
import MacVMCore

// A write to a closed socket or pipe fails with EPIPE; it never kills the helper.
signal(SIGPIPE, SIG_IGN)

let argv = Array(CommandLine.arguments.dropFirst())
let command: Command
do {
    command = try parseCommand(argv)
} catch let e as HelperError {
    failEarly(e)
}

let ph = ProcessHooks()
switch command {
case .version:
    let line = try JSONSerialization.data(withJSONObject: [
        "helper": helperVersion, "contract": contractVersion, "agent": agentVersion,
        "provisioning": provisioningCompiledIn,
    ] as [String: Any], options: [.sortedKeys])
    writeAll(1, line + Data("\n".utf8))
    exit(cleanExitCode)
case .catalog:
    runCatalog(ph.hooks)
case .inspect(let ipsw):
    runInspect(ipsw: ipsw, ph.hooks)
case .install(let args):
    runInstall(args, ph)
case .provision(let args):
    runProvision(args, ph)
case .saveState(let args):
    runSaveState(args, ph)
case .run(let args):
    runJob(args, ph)
case .check(let args):
    runCheck(args, ph.hooks)
}
