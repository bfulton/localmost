// localmost-vm: runs one Linux VM for localmost, under its own seatbelt
// profile, and speaks the control protocol of contract §2.4 on stdio.
//
//   localmost-vm run --vm-id <id> --mode job|refresh ...   (contract §2.1)
//   localmost-vm version
//
// Everything it touches is derived from its arguments; nothing on its command
// line is a path a job chose.

import Foundation

// A write to a closed socket or pipe fails with EPIPE; it never kills the helper.
signal(SIGPIPE, SIG_IGN)

let argv = Array(CommandLine.arguments.dropFirst())
do {
    switch try parseCommand(argv) {
    case .version:
        let line = try JSONSerialization.data(withJSONObject: ["helper": helperVersion, "contract": contractVersion], options: [.sortedKeys])
        writeAll(1, line + Data("\n".utf8))
        exit(0)
    case .run(let args):
        Helper(args).run()
    }
} catch let e as HelperError {
    if argv.first == "run" {
        // Electron reads why from the last event, as for any other failure.
        Helper.failEarly(e)
    }
    // Only `run` speaks the control protocol; anything else just says why.
    logLine("error", e.message)
    exit(e.code.exitCode)
}
