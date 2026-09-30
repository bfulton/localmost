// Command lm-init is the guest's PID 1 (contract §3.2). It mounts the
// kernel filesystems and tmpfs directories, loads the module allowlist and
// then disables module loading and kexec for good, brings up lo, and starts
// lm-agent once. It reaps orphans, and when the agent exits, for any
// reason, it stops everything, syncs and powers the guest off.
//
// Run as /sbin/modprobe (a link to it), it is the modprobe that the kernel
// and dockerd find after boot: it loads nothing (see internal/kmod).
package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	if filepath.Base(os.Args[0]) == "modprobe" {
		os.Exit(modprobe())
	}
	if err := initMain(); err != nil {
		fmt.Fprintf(os.Stderr, "lm-init: %v\n", err)
		os.Exit(1)
	}
}
