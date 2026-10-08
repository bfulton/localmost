//go:build linux && guestvm

// These tests run only inside the guest, as root in its initial namespaces
// with the job's share mounted: the acceptance harness builds them with
// `go test -c -tags guestvm` and runs the binary in the guest, with
// LM_SHARE naming the share's mount path. They exercise the real
// namespace, openat2, statx and mount_setattr calls against real mounts
// of the virtiofs share.

package bindpin

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"

	"github.com/bfulton/localmost/guest/internal/mountinfo"
	"github.com/bfulton/localmost/guest/internal/proto"
)

// TestMain doubles as the "container": with LM_CHILD set, the binary makes
// its own mounts in the new mount namespace it was started in, reports
// ready, and waits.
func TestMain(m *testing.M) {
	if spec := os.Getenv("LM_CHILD"); spec != "" {
		child(spec)
		return
	}
	os.Exit(m.Run())
}

type childSpec struct {
	Rootfs string
	Binds  [][2]string // share source, destination under rootfs
	Cover  string      // a destination to cover with a tmpfs afterwards
}

func child(raw string) {
	var s childSpec
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		panic(err)
	}
	must(unix.Mount("", "/", "", unix.MS_REC|unix.MS_PRIVATE, ""))
	for _, b := range s.Binds {
		dst := filepath.Join(s.Rootfs, b[1])
		must(os.MkdirAll(dst, 0o755))
		// As runc does: a recursive bind of the source, which inherits
		// nosymfollow from the share.
		must(unix.Mount(b[0], dst, "", unix.MS_BIND|unix.MS_REC, ""))
	}
	if s.Cover != "" {
		must(unix.Mount("tmpfs", filepath.Join(s.Rootfs, s.Cover), "tmpfs", 0, ""))
	}
	os.Stdout.WriteString("ready\n")
	select {}
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func share(t *testing.T) Share {
	t.Helper()
	d := LinuxDeps{}
	s, ok, err := d.FindShare()
	if err != nil || !ok || s.Path != os.Getenv("LM_SHARE") {
		t.Fatalf("share %+v %v %v (LM_SHARE=%q)", s, ok, err, os.Getenv("LM_SHARE"))
	}
	return s
}

// startChild starts the test binary in a new mount namespace as a stand-in
// container and waits until its mounts are made.
func startChild(t *testing.T, spec childSpec) int {
	t.Helper()
	raw, _ := json.Marshal(spec)
	cmd := exec.Command("/proc/self/exe")
	cmd.Env = append(os.Environ(), "LM_CHILD="+string(raw))
	cmd.SysProcAttr = &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWNS}
	cmd.Stderr = os.Stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil || line != "ready\n" {
		t.Fatalf("child: %q %v", line, err)
	}
	return cmd.Process.Pid
}

// flags returns the per-mount options of the mount at mountPoint in pid's
// namespace.
func flags(t *testing.T, pid int, mountPoint string) []string {
	t.Helper()
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/mountinfo")
	if err != nil {
		t.Fatal(err)
	}
	ms, err := mountinfo.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, m := range ms {
		if m.MountPoint == mountPoint {
			out = m.Options // the last one listed is the topmost
		}
	}
	return out
}

func has(opts []string, o string) bool {
	for _, x := range opts {
		if x == o {
			return true
		}
	}
	return false
}

// fixture makes two directories on the share and a rootfs outside it.
func fixture(t *testing.T, s Share) (rootfs, a, b string) {
	t.Helper()
	dir, err := os.MkdirTemp(s.Path, "bindpin-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	a, b = filepath.Join(dir, "a"), filepath.Join(dir, "b")
	must(os.Mkdir(a, 0o755))
	must(os.Mkdir(b, 0o755))
	rootfs, err = os.MkdirTemp("/tmp", "rootfs-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(rootfs) })
	return rootfs, a, b
}

// pin runs Pin inside the child's namespace on a goroutine of its own, as
// lm-bindpin does from its main thread.
func pin(t *testing.T, pid int, s Share, rootfs string, approved []proto.Bind) error {
	t.Helper()
	res := make(chan error, 1)
	go func() {
		ns, err := LinuxDeps{}.Enter(pid)
		if err != nil {
			res <- err
			return
		}
		res <- Pin(ns, s, rootfs, approved, nil)
	}()
	return <-res
}

func TestGuestUnpinsApprovedBindsAndKeepsNosuid(t *testing.T) {
	s := share(t)
	rootfs, a, b := fixture(t, s)
	pid := startChild(t, childSpec{Rootfs: rootfs, Binds: [][2]string{{a, "/a"}, {b, "/b"}}})
	for _, d := range []string{"/a", "/b"} {
		if !has(flags(t, pid, rootfs+d), "nosymfollow") {
			t.Fatalf("%s is not nosymfollow before the hook", d)
		}
	}
	approved := []proto.Bind{{Source: a, Destination: "/a"}, {Source: b, Destination: "/b"}}
	if err := pin(t, pid, s, rootfs, approved); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"/a", "/b"} {
		f := flags(t, pid, rootfs+d)
		if has(f, "nosymfollow") || !has(f, "nosuid") || !has(f, "nodev") {
			t.Fatalf("%s after the hook: %v", d, f)
		}
	}
}

func TestGuestClearsNoFlagWhenAMountIsNotTheOneRecorded(t *testing.T) {
	s := share(t)
	rootfs, a, b := fixture(t, s)
	// /b is covered by a tmpfs: mountinfo lists the share mount there, but
	// opening the path reaches the tmpfs, whose mount id differs.
	pid := startChild(t, childSpec{Rootfs: rootfs, Binds: [][2]string{{a, "/a"}, {b, "/b"}}, Cover: "/b"})
	approved := []proto.Bind{{Source: a, Destination: "/a"}, {Source: b, Destination: "/b"}}
	err := pin(t, pid, s, rootfs, approved)
	if err == nil || !strings.Contains(err.Error(), "not the") {
		t.Fatalf("got %v", err)
	}
	if !has(flags(t, pid, rootfs+"/a"), "nosymfollow") {
		t.Fatal("/a was unpinned although /b failed")
	}
}

func TestGuestHookFailsWhenTheAgentIsUnreachable(t *testing.T) {
	s := share(t)
	rootfs, a, _ := fixture(t, s)
	pid := startChild(t, childSpec{Rootfs: rootfs, Binds: [][2]string{{a, "/a"}}})
	bundle := t.TempDir()
	cfg := map[string]any{
		"root":   map[string]any{"path": rootfs},
		"mounts": []map[string]any{{"destination": "/a", "type": "bind", "source": a, "options": []string{"rbind"}}},
	}
	raw, _ := json.Marshal(cfg)
	must(os.WriteFile(filepath.Join(bundle, "config.json"), raw, 0o600))
	st, _ := json.Marshal(State{ID: strings.Repeat("ab", 32), Pid: pid, Bundle: bundle})
	err := Run(strings.NewReader(string(st)), LinuxDeps{AgentSocket: "/run/localmost/no-such-agent.sock"})
	if err == nil || !strings.Contains(err.Error(), "approvals could not be read") {
		t.Fatalf("got %v", err)
	}
	if !has(flags(t, pid, rootfs+"/a"), "nosymfollow") {
		t.Fatal("/a was unpinned")
	}
}
