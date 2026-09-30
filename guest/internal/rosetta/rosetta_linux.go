//go:build linux

package rosetta

import (
	"context"
	"os"
	"os/exec"
	"time"

	"golang.org/x/sys/unix"
)

// Setup mounts the rosetta share and registers it, then runs the x86-64
// self-test binary. It reports Absent when not enabled, and Broken when
// any step fails.
func Setup(enabled bool, logf func(string, ...any)) string {
	if !enabled {
		return Absent
	}
	if err := os.MkdirAll(MountPoint, 0o755); err != nil {
		logf("rosetta: mkdir: %v", err)
		return Broken
	}
	if err := unix.Mount("rosetta", MountPoint, "virtiofs", unix.MS_RDONLY|unix.MS_NODEV|unix.MS_NOSUID, ""); err != nil {
		logf("rosetta: mount: %v", err)
		return Broken
	}
	const bm = "/proc/sys/fs/binfmt_misc"
	if _, err := os.Stat(bm + "/register"); err != nil {
		if err := unix.Mount("binfmt_misc", bm, "binfmt_misc", unix.MS_NODEV|unix.MS_NOSUID|unix.MS_NOEXEC, ""); err != nil {
			logf("rosetta: mount binfmt_misc: %v", err)
			return Broken
		}
	}
	if err := os.WriteFile(bm+"/register", []byte(Register), 0); err != nil {
		logf("rosetta: register: %v", err)
		return Broken
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// The static busybox runs as `busybox true`: argv[0] names the applet.
	cmd := exec.CommandContext(ctx, Selftest, "true")
	cmd.Args[0] = "busybox"
	if out, err := cmd.CombinedOutput(); err != nil {
		logf("rosetta: self-test: %v: %s", err, string(out))
		return Broken
	}
	return OK
}
