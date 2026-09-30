// Command lm-agent is the guest agent (contract §3.1–§3.6): the control
// protocol on vsock 1025, the Docker API splice on vsock 2375, the
// guest-local socket lm-bindpin asks for approvals, and everything
// configure sets up. lm-init starts it once and powers the guest off when it
// exits.
package main

import (
	"fmt"
	"os"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "lm-agent: %v\n", err)
		os.Exit(1)
	}
}
