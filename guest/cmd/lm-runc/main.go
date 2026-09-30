// Command lm-runc is installed as /usr/bin/runc in the guest (contract
// §3.7). For create, run and restore it adds the lm-bindpin hook to the
// bundle's config.json; then, for every subcommand, it execs the real runc
// at /usr/libexec/localmost/runc with the same arguments. If the hook
// cannot be added, the container is not created.
package main

import (
	"fmt"
	"os"
	"syscall"
)

const realRunc = "/usr/libexec/localmost/runc"

func main() {
	sub, bundle, err := parseArgs(os.Args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if needsHook(sub) {
		if bundle == "" {
			bundle = "."
		}
		if err := addHook(bundle); err != nil {
			fmt.Fprintf(os.Stderr, "localmost: could not add the bind hook: %v\n", err)
			os.Exit(1)
		}
	}
	err = syscall.Exec(realRunc, os.Args, os.Environ())
	fmt.Fprintf(os.Stderr, "lm-runc: exec %s: %v\n", realRunc, err)
	os.Exit(1)
}
