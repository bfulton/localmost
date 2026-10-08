package main

import (
	"errors"
	"os"
	"runtime"
	"syscall"
	"testing"
)

func rdev(fd uintptr) (uint64, error) {
	var st syscall.Stat_t
	if err := syscall.Fstat(int(fd), &st); err != nil {
		return 0, err
	}
	return uint64(st.Rdev), nil
}

func TestForkExecNullStdinHoldsDevNullOpenThroughForkExecAndClosesItAfter(t *testing.T) {
	want, err := os.Stat(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	wantRdev := uint64(want.Sys().(*syscall.Stat_t).Rdev)
	var stdin uintptr
	pid, err := forkExecNullStdin(func(path string, argv []string, attr *syscall.ProcAttr) (int, error) {
		if path != "/agent" || len(argv) != 1 || argv[0] != "agent" || attr.Dir != "/" {
			t.Errorf("forkExec got %q %q dir %q", path, argv, attr.Dir)
		}
		if len(attr.Files) != 3 || attr.Files[1] != 2 || attr.Files[2] != 2 {
			t.Fatalf("files = %v, want [/dev/null 2 2]", attr.Files)
		}
		stdin = attr.Files[0]
		// A file nothing references any more is closed by its finalizer.
		for i := 0; i < 5; i++ {
			runtime.GC()
		}
		got, err := rdev(stdin)
		if err != nil || got != wantRdev {
			t.Errorf("stdin %d during forkExec: rdev %d, %v; want /dev/null (rdev %d)", stdin, got, err, wantRdev)
		}
		return 42, nil
	}, "/agent", []string{"agent"}, syscall.ProcAttr{Dir: "/"}, 2)
	if pid != 42 || err != nil {
		t.Fatalf("got %d, %v", pid, err)
	}
	if _, err := rdev(stdin); !errors.Is(err, syscall.EBADF) {
		t.Errorf("stdin %d is still open after forkExec returned (fstat: %v)", stdin, err)
	}
}

func TestForkExecNullStdinClosesDevNullWhenForkExecFails(t *testing.T) {
	var stdin uintptr
	_, err := forkExecNullStdin(func(_ string, _ []string, attr *syscall.ProcAttr) (int, error) {
		stdin = attr.Files[0]
		return 0, syscall.ENOENT
	}, "/missing", []string{"missing"}, syscall.ProcAttr{}, 2)
	if !errors.Is(err, syscall.ENOENT) {
		t.Fatalf("err = %v, want ENOENT", err)
	}
	if _, err := rdev(stdin); !errors.Is(err, syscall.EBADF) {
		t.Errorf("stdin %d is still open after a failed forkExec (fstat: %v)", stdin, err)
	}
}
