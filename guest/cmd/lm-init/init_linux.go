//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/bfulton/localmost/guest/internal/kmod"
)

const (
	agentPath  = "/usr/libexec/localmost/lm-agent"
	moduleList = "/etc/localmost/modules"
	guestPATH  = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	killGrace  = 5 * time.Second
)

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "lm-init: "+format+"\n", args...)
}

func release() string {
	var u unix.Utsname
	unix.Uname(&u)
	return unix.ByteSliceToString(u.Release[:])
}

func modprobe() int { return kmod.Modprobe(os.Args, "/lib/modules/"+release()) }

type mnt struct {
	source, target, fstype string
	flags                  uintptr
	data                   string
}

// The mounts made before anything else runs. /dev came from the initramfs.
var mounts = []mnt{
	{"proc", "/proc", "proc", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, ""},
	{"sysfs", "/sys", "sysfs", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, ""},
	{"cgroup2", "/sys/fs/cgroup", "cgroup2", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, "nsdelegate"},
	{"tmpfs", "/run", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV, "mode=0755"},
	{"tmpfs", "/tmp", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV, "mode=1777"},
	{"tmpfs", "/var/log", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, "mode=0755"},
	{"tmpfs", "/var/tmp", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV, "mode=1777"},
	{"devpts", "/dev/pts", "devpts", unix.MS_NOSUID | unix.MS_NOEXEC, "newinstance,ptmxmode=0666,mode=0620"},
	{"tmpfs", "/dev/shm", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV, "mode=1777"},
}

// The sysctls, in order. The last two are one-way until reboot and come
// after every module is loaded: the kernel has MODULE_SIG without
// MODULE_SIG_FORCE, so without them guest root could load any module.
var sysctls = [][2]string{
	{"net/ipv4/ip_forward", "1"},
	{"net/bridge/bridge-nf-call-iptables", "1"},
	{"kernel/dmesg_restrict", "1"},
	{"kernel/panic_on_oops", "1"},
	{"kernel/kexec_load_disabled", "1"},
	{"kernel/modules_disabled", "1"},
}

func initMain() error {
	if os.Getpid() != 1 {
		return errors.New("not PID 1")
	}
	sigs := make(chan os.Signal, 16)
	signal.Notify(sigs, unix.SIGCHLD, unix.SIGTERM, unix.SIGINT, unix.SIGPWR)
	if err := boot(); err != nil {
		logf("boot failed: %v", err)
		powerOff()
	}
	agent, err := startAgent()
	if err != nil {
		logf("could not start the agent: %v", err)
		powerOff()
	}
	for sig := range sigs {
		if sig != unix.SIGCHLD {
			logf("%v: powering off", sig)
			powerOff()
		}
		for {
			var ws unix.WaitStatus
			pid, err := unix.Wait4(-1, &ws, unix.WNOHANG, nil)
			if pid <= 0 || err != nil {
				break
			}
			if pid == agent {
				logf("the agent exited (%s): powering off", describe(ws))
				powerOff()
			}
		}
	}
	return nil
}

func describe(ws unix.WaitStatus) string {
	if ws.Signaled() {
		return "signal " + ws.Signal().String()
	}
	return fmt.Sprintf("status %d", ws.ExitStatus())
}

func boot() error {
	for _, m := range mounts {
		if err := os.MkdirAll(m.target, 0o755); err != nil && !errors.Is(err, unix.EROFS) {
			return err
		}
		if err := unix.Mount(m.source, m.target, m.fstype, m.flags, m.data); err != nil {
			return fmt.Errorf("mount %s: %w", m.target, err)
		}
	}
	start := time.Now()
	loaded, err := kmod.LoadList("/lib/modules/"+release(), moduleList)
	if err != nil {
		return fmt.Errorf("modules: %w", err)
	}
	logf("loaded %d modules in %s", len(loaded), time.Since(start).Round(time.Millisecond))
	for _, s := range sysctls {
		if err := os.WriteFile("/proc/sys/"+s[0], []byte(s[1]), 0); err != nil {
			return fmt.Errorf("sysctl %s: %w", strings.ReplaceAll(s[0], "/", "."), err)
		}
	}
	if err := unix.Sethostname([]byte("localmost")); err != nil {
		return err
	}
	if out, err := exec.Command("/sbin/ip", "link", "set", "lo", "up").CombinedOutput(); err != nil {
		return fmt.Errorf("lo up: %v: %s", err, out)
	}
	return nil
}

// startAgent starts lm-agent with the console as its output. lm-init waits
// for it itself (with wait4), so that no reaping races an exec.Cmd.
func startAgent() (int, error) {
	pid, err := syscall.ForkExec(agentPath, []string{"lm-agent"}, &syscall.ProcAttr{
		Dir:   "/",
		Env:   []string{guestPATH, "HOME=/root"},
		Files: []uintptr{devNull(), os.Stderr.Fd(), os.Stderr.Fd()},
		Sys:   &syscall.SysProcAttr{Setsid: true},
	})
	return pid, err
}

func devNull() uintptr {
	f, err := os.Open("/dev/null")
	if err != nil {
		return os.Stdin.Fd()
	}
	return f.Fd()
}

// powerOff stops every process (TERM, then KILL after 5 s), syncs,
// unmounts the data disk, and powers the guest off. It never returns.
func powerOff() {
	unix.Kill(-1, unix.SIGTERM)
	deadline := time.Now().Add(killGrace)
	for time.Now().Before(deadline) {
		var ws unix.WaitStatus
		pid, err := unix.Wait4(-1, &ws, unix.WNOHANG, nil)
		if err == unix.ECHILD {
			break
		}
		if pid <= 0 {
			time.Sleep(50 * time.Millisecond)
		}
	}
	unix.Kill(-1, unix.SIGKILL)
	unix.Sync()
	for _, m := range []string{"/var/lib/containerd", "/var/lib/docker"} {
		if err := unix.Unmount(m, 0); err != nil && err != unix.EINVAL {
			unix.Mount("", m, "", unix.MS_REMOUNT|unix.MS_RDONLY, "")
		}
	}
	unix.Sync()
	for {
		unix.Reboot(unix.LINUX_REBOOT_CMD_POWER_OFF)
		time.Sleep(time.Second)
	}
}
