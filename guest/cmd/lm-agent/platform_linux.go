//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/bfulton/localmost/guest/internal/agent"
	"github.com/bfulton/localmost/guest/internal/dockerapi"
	"github.com/bfulton/localmost/guest/internal/firewall"
	"github.com/bfulton/localmost/guest/internal/relay"
	"github.com/bfulton/localmost/guest/internal/rosetta"
	"github.com/bfulton/localmost/guest/internal/selftest"
	"github.com/bfulton/localmost/guest/internal/vsock"
)

const (
	dataDisk    = "/dev/vdb"
	dockerRoot  = "/var/lib/docker"
	containerd  = "/var/lib/containerd"
	dockerdLog  = "/var/log/dockerd.log"
	maxLogBytes = 16 << 20
	pingWait    = 30 * time.Second
)

type platform struct {
	logf  func(string, ...any)
	relay *relay.Relay
	// forget drops a destroyed container's bind approvals.
	forget func(container string)

	mu      sync.Mutex
	dockerd *exec.Cmd
	exited  chan struct{}
	ring    *lineRing
	tracker firewall.Tracker
}

func newPlatform(logf func(string, ...any)) *platform {
	return &platform{logf: logf, ring: newLineRing(20, 512)}
}

func (p *platform) Hello() (string, string) {
	var rel struct {
		GuestVersion string `json:"guestVersion"`
	}
	if b, err := os.ReadFile("/etc/localmost/release.json"); err == nil {
		json.Unmarshal(b, &rel)
	}
	var u unix.Utsname
	unix.Uname(&u)
	return rel.GuestVersion, unix.ByteSliceToString(u.Release[:])
}

func (p *platform) SetClock(ms int64) error {
	ts := unix.NsecToTimespec(ms * int64(time.Millisecond))
	return unix.ClockSettime(unix.CLOCK_REALTIME, &ts)
}

// hasExt4 reads the ext2/3/4 superblock magic (0xEF53 at byte 1080).
func hasExt4(dev string) (bool, error) {
	f, err := os.Open(dev)
	if err != nil {
		return false, err
	}
	defer f.Close()
	var magic [2]byte
	if _, err := f.ReadAt(magic[:], 1024+0x38); err != nil {
		return false, err
	}
	return binary.LittleEndian.Uint16(magic[:]) == 0xEF53, nil
}

func (p *platform) PrepareDisk() (string, error) {
	state := agent.DiskExisting
	ok, err := hasExt4(dataDisk)
	if err != nil {
		return "", err
	}
	if !ok {
		if out, err := exec.Command("mke2fs", "-t", "ext4", "-F", "-q", "-L", "lmdata", dataDisk).CombinedOutput(); err != nil {
			return "", fmt.Errorf("mke2fs: %v: %s", err, lastLine(out))
		}
		state = agent.DiskFormatted
	} else if out, err := exec.Command("e2fsck", "-n", dataDisk).CombinedOutput(); err != nil {
		p.logf("e2fsck -n: %v: %s", err, lastLine(out))
		return agent.DiskCorrupt, nil
	}
	if err := unix.Mount(dataDisk, dockerRoot, "ext4", 0, ""); err != nil {
		if state == agent.DiskExisting {
			p.logf("mount %s: %v", dataDisk, err)
			return agent.DiskCorrupt, nil
		}
		return "", fmt.Errorf("mount %s: %w", dataDisk, err)
	}
	inner := dockerRoot + "/.containerd"
	if err := os.MkdirAll(inner, 0o711); err != nil {
		return "", err
	}
	if err := unix.Mount(inner, containerd, "", unix.MS_BIND, ""); err != nil {
		return "", fmt.Errorf("bind %s: %w", containerd, err)
	}
	return state, nil
}

// MountShare mounts a tmpfs on /<top> (one of the empty mount roots the
// read-only root provides), makes the path, mounts the share there nosuid,
// nodev and nosymfollow, and reads the nonce file without following a link.
func (p *platform) MountShare(top, mountPath, nonceFile string) (string, error) {
	if err := unix.Mount("tmpfs", "/"+top, "tmpfs", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, "mode=0755,size=1m"); err != nil {
		return "", fmt.Errorf("tmpfs on /%s: %w", top, err)
	}
	if err := os.MkdirAll(mountPath, 0o755); err != nil {
		return "", err
	}
	if err := unix.Mount("work", mountPath, "virtiofs", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOSYMFOLLOW, ""); err != nil {
		return "", fmt.Errorf("virtiofs work on %s: %w", mountPath, err)
	}
	fd, err := unix.Open(mountPath+"/"+nonceFile, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", fmt.Errorf("nonce file: %w", err)
	}
	defer unix.Close(fd)
	buf := make([]byte, 65)
	n, err := unix.Read(fd, buf)
	if err != nil {
		return "", fmt.Errorf("nonce file: %w", err)
	}
	if n > 64 {
		return "", errors.New("nonce file: longer than 64 bytes")
	}
	nonce := strings.TrimRight(string(buf[:n]), "\n")
	for _, r := range nonce {
		if r < 0x21 || r > 0x7e {
			return "", errors.New("nonce file: not printable")
		}
	}
	return nonce, nil
}

func (p *platform) SetupRosetta(enabled bool) string { return rosetta.Setup(enabled, p.logf) }

func command(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, lastLine(out))
	}
	return nil
}

func (p *platform) SetupNetwork(job bool) error {
	if job {
		for _, s := range [][]string{
			{"link", "add", "lm0", "type", "dummy"},
			{"addr", "add", "198.18.0.1/32", "dev", "lm0"},
			{"link", "set", "lm0", "up"},
		} {
			if err := command("ip", s...); err != nil {
				return err
			}
		}
	}
	for _, r := range firewall.Rules() {
		if err := command("iptables", r...); err != nil {
			return err
		}
	}
	if !job {
		return nil
	}
	l, err := net.Listen("tcp4", "198.18.0.1:3128")
	if err != nil {
		return fmt.Errorf("relay listen: %w", err)
	}
	p.relay = relay.New(func() (relay.Conn, error) { return vsock.Dial(3128) }, 256)
	go p.relay.Serve(l)
	return nil
}

func (p *platform) StartDockerd(job bool) (agent.DockerVersion, error) {
	logFile, err := os.OpenFile(dockerdLog, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return agent.DockerVersion{}, err
	}
	out := io.MultiWriter(&cappedWriter{w: logFile, left: maxLogBytes}, p.ring)
	cmd := exec.Command("dockerd", "--config-file", "/etc/docker/daemon.json")
	cmd.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root"}
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		return agent.DockerVersion{}, err
	}
	exited := make(chan struct{})
	p.mu.Lock()
	p.dockerd, p.exited = cmd, exited
	p.mu.Unlock()
	go func() {
		cmd.Wait()
		logFile.Close()
		close(exited)
	}()
	c := dockerapi.Unix(dockerSock)
	deadline := time.Now().Add(pingWait)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := c.Ping(ctx)
		cancel()
		if err == nil {
			break
		}
		select {
		case <-exited:
			return agent.DockerVersion{}, fmt.Errorf("dockerd exited before answering /_ping; its last lines:\n%s", p.ring.String())
		case <-time.After(50 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			return agent.DockerVersion{}, fmt.Errorf("dockerd did not answer /_ping within %s; its last lines:\n%s", pingWait, p.ring.String())
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	v, err := c.Version(ctx)
	if err != nil {
		return agent.DockerVersion{}, fmt.Errorf("GET /version: %w", err)
	}
	if job {
		go p.followNetworks(c)
	}
	return agent.DockerVersion{Version: v.Version, APIVersion: v.APIVersion, MinAPIVersion: v.MinAPIVersion}, nil
}

// followNetworks keeps LOCALMOST-RELAY in step with Docker's networks for
// as long as dockerd runs: it opens the event stream first and then lists
// what exists, so that nothing created in between is missed. It also drops
// a container's bind approvals when Docker destroys it.
func (p *platform) followNetworks(c dockerapi.Client) {
	created := func(id string) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		n, err := c.Network(ctx, id)
		cancel()
		if err != nil {
			p.logf("network %s: %v", short(id), err)
			return
		}
		for _, rule := range p.tracker.Created(n) {
			if err := command("iptables", rule...); err != nil {
				p.logf("relay rule for %s: %v", short(id), err)
			}
		}
	}
	for p.DockerdRunning() {
		err := c.Events(context.Background(), func() {
			// Rebuild LOCALMOST-RELAY from what exists now, on the first
			// subscription and after every reconnect.
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			list, err := c.Networks(ctx)
			cancel()
			if err != nil {
				p.logf("networks: %v", err)
				return
			}
			var ns []firewall.Network
			for _, l := range list {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				n, err := c.Network(ctx, l.ID)
				cancel()
				if err != nil {
					p.logf("network %s: %v", short(l.ID), err)
					continue
				}
				ns = append(ns, n)
			}
			for _, rule := range p.tracker.Sync(ns) {
				if err := command("iptables", rule...); err != nil {
					p.logf("relay chain: %v", err)
				}
			}
		}, func(ev dockerapi.Event) {
			switch {
			case ev.Type == "network" && ev.Action == "create":
				created(ev.ID)
			case ev.Type == "network" && ev.Action == "destroy":
				if rule, ok := p.tracker.Destroyed(ev.ID); ok {
					if err := command("iptables", rule...); err != nil {
						p.logf("relay rule for %s: %v", short(ev.ID), err)
					}
				}
			case ev.Type == "container" && ev.Action == "destroy":
				if p.forget != nil {
					p.forget(ev.ID)
				}
			}
		})
		p.logf("network events: %v", err)
		time.Sleep(200 * time.Millisecond)
	}
}

func short(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func (p *platform) SelfTest(job bool) agent.Selftest {
	ignore := func(string) func() { return func() {} }
	if p.relay != nil {
		ignore = p.relay.Ignore
	}
	return selftest.Run(job, ignore, p.logf)
}

func (p *platform) DockerdRunning() bool {
	p.mu.Lock()
	exited := p.exited
	p.mu.Unlock()
	if exited == nil {
		return false
	}
	select {
	case <-exited:
		return false
	default:
		return true
	}
}

func (p *platform) UptimeMs() int64 {
	var ts unix.Timespec
	unix.ClockGettime(unix.CLOCK_BOOTTIME, &ts)
	return ts.Nano() / int64(time.Millisecond)
}

// Shutdown stops dockerd (SIGTERM, then SIGKILL after 15 s), syncs,
// unmounts the data disk, and exits; lm-init then powers the guest off.
func (p *platform) Shutdown() {
	p.mu.Lock()
	cmd, exited := p.dockerd, p.exited
	p.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-exited:
		case <-time.After(15 * time.Second):
			cmd.Process.Kill()
			<-exited
		}
	}
	unix.Sync()
	for _, m := range []string{containerd, dockerRoot} {
		if err := unix.Unmount(m, 0); err != nil && !errors.Is(err, unix.EINVAL) {
			p.logf("unmount %s: %v", m, err)
		}
	}
	unix.Sync()
	p.logf("shut down")
	os.Exit(0)
}

func lastLine(b []byte) string {
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	return lines[len(lines)-1]
}

// lineRing keeps the last n lines written to it, each cut at max bytes.
type lineRing struct {
	mu      sync.Mutex
	n, max  int
	lines   []string
	partial bytes.Buffer
}

func newLineRing(n, max int) *lineRing { return &lineRing{n: n, max: max} }

func (r *lineRing) Write(b []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range b {
		if c == '\n' {
			line := r.partial.String()
			if len(line) > r.max {
				line = line[:r.max]
			}
			r.lines = append(r.lines, line)
			if len(r.lines) > r.n {
				r.lines = r.lines[len(r.lines)-r.n:]
			}
			r.partial.Reset()
		} else if r.partial.Len() < r.max {
			r.partial.WriteByte(c)
		}
	}
	return len(b), nil
}

func (r *lineRing) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.lines, "\n")
}

// cappedWriter writes until its budget is spent and then drops the rest,
// so that dockerd's log cannot fill the guest's tmpfs.
type cappedWriter struct {
	w    io.Writer
	left int
}

func (c *cappedWriter) Write(b []byte) (int, error) {
	n := len(b)
	if c.left <= 0 {
		return n, nil
	}
	if len(b) > c.left {
		b = b[:c.left]
	}
	c.left -= len(b)
	c.w.Write(b)
	return n, nil
}
