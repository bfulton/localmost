// Command lm-bindpin is the OCI createRuntime hook that lm-runc adds to
// every container (contract §3.7, the design's share layout rule 7). Every
// mount of the job's share must be a bind the filter approved; only then is
// nosymfollow cleared, on those binds alone. Any error exits 1, and runc
// then fails the start with the message on stderr.
package main

import (
	"fmt"
	"os"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
