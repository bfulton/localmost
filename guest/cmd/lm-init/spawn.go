package main

import (
	"os"
	"syscall"
)

// forkExecNullStdin runs forkExec with /dev/null as the child's stdin and
// out as its stdout and stderr. The parent holds the /dev/null file open
// until forkExec has returned, so no finalizer can close the descriptor
// while the child is being set up, and closes it then, so a start leaves
// no descriptor behind. If /dev/null cannot be opened, the child gets the
// parent's stdin instead.
func forkExecNullStdin(forkExec func(string, []string, *syscall.ProcAttr) (int, error),
	path string, argv []string, attr syscall.ProcAttr, out uintptr) (int, error) {
	stdin := os.Stdin
	if null, err := os.Open(os.DevNull); err == nil {
		defer null.Close()
		stdin = null
	}
	attr.Files = []uintptr{stdin.Fd(), out, out}
	return forkExec(path, argv, &attr)
}
