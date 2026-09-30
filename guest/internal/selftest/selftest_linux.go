//go:build linux

// Package selftest checks the guest firewall from a scratch network
// namespace once dockerd is up (contract §3.6): the rules are the golden
// ones, a namespace on a bridge outside LOCALMOST-RELAY cannot reach the
// relay by routing or by a forged route, cannot reach a 0.0.0.0 listener
// on its gateway, and reaches the relay once its bridge is let in.
package selftest

import (
	"errors"
	"fmt"
	"net"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/bfulton/localmost/guest/internal/agent"
	"github.com/bfulton/localmost/guest/internal/firewall"
)

// The scratch network: a bridge, a veth into a namespace, and a /29 from
// the shared address space that Docker's default pools do not use.
const (
	Bridge  = "lmst0"
	NS      = "lmst"
	vethH   = "lmst-h"
	vethN   = "lmst-n"
	Gateway = "100.127.254.1"
	Client  = "100.127.254.2"
	relayIP = "198.18.0.1"
)

// Run is the self-test. `ignore` makes the relay drop the probe's own
// connections so that they never reach the job's proxy. In refresh mode
// only the rules are checked.
func Run(job bool, ignore func(ip string) (undo func()), logf func(string, ...any)) agent.Selftest {
	var st agent.Selftest
	st.Rules = checkRules(logf)
	if !job {
		return st
	}
	cleanup(logf)
	defer cleanup(logf)
	if err := setup(); err != nil {
		logf("selftest: setup: %v", err)
		return st
	}
	nsPath := "/run/netns/" + NS
	undo := ignore(Client)
	defer undo()

	err := connectIn(nsPath, relayIP, 3128)
	st.InternalNoRelay = errors.Is(err, unix.ENETUNREACH)
	logf("selftest: internal to relay: %v", err)

	if err := run("ip", "-n", NS, "route", "add", relayIP+"/32", "via", Gateway); err != nil {
		logf("selftest: forged route: %v", err)
	} else {
		err := connectIn(nsPath, relayIP, 3128)
		st.InternalForgedRejected = errors.Is(err, unix.ECONNREFUSED)
		logf("selftest: forged route to relay: %v", err)
	}

	st.GatewayRejected = gatewayRejected(nsPath, logf)

	if err := run("iptables", firewall.RelayRule("-A", Bridge)...); err != nil {
		logf("selftest: relay rule: %v", err)
		return st
	}
	defer run("iptables", firewall.RelayRule("-D", Bridge)...)
	if err := run("ip", "-n", NS, "route", "add", "default", "via", Gateway); err != nil {
		logf("selftest: default route: %v", err)
		return st
	}
	err = connectIn(nsPath, relayIP, 3128)
	st.BridgeReachesRelay = err == nil
	logf("selftest: routable bridge to relay: %v", err)
	return st
}

func checkRules(logf func(string, ...any)) bool {
	chain, err1 := output("iptables", "-S", "LOCALMOST-INPUT")
	input, err2 := output("iptables", "-S", "INPUT")
	if err1 != nil || err2 != nil {
		logf("selftest: iptables -S: %v %v", err1, err2)
		return false
	}
	if err := firewall.CheckRules(chain, input); err != nil {
		logf("selftest: rules: %v", err)
		return false
	}
	return true
}

func gatewayRejected(nsPath string, logf func(string, ...any)) bool {
	l, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		logf("selftest: listen: %v", err)
		return false
	}
	defer l.Close()
	accepted := make(chan struct{}, 1)
	go func() {
		if c, err := l.Accept(); err == nil {
			accepted <- struct{}{}
			c.Close()
		}
	}()
	port := l.Addr().(*net.TCPAddr).Port
	err = connectIn(nsPath, Gateway, port)
	logf("selftest: gateway 0.0.0.0 listener: %v", err)
	select {
	case <-accepted:
		return false
	case <-time.After(50 * time.Millisecond):
	}
	return errors.Is(err, unix.ECONNREFUSED) || errors.Is(err, unix.EHOSTUNREACH) || errors.Is(err, unix.ENETUNREACH)
}

func setup() error {
	steps := [][]string{
		{"ip", "link", "add", Bridge, "type", "bridge"},
		{"ip", "addr", "add", Gateway + "/29", "dev", Bridge},
		{"ip", "link", "set", Bridge, "up"},
		{"ip", "netns", "add", NS},
		{"ip", "link", "add", vethH, "type", "veth", "peer", "name", vethN},
		{"ip", "link", "set", vethH, "master", Bridge, "up"},
		{"ip", "link", "set", vethN, "netns", NS},
		{"ip", "-n", NS, "addr", "add", Client + "/29", "dev", vethN},
		{"ip", "-n", NS, "link", "set", vethN, "up"},
		{"ip", "-n", NS, "link", "set", "lo", "up"},
	}
	for _, s := range steps {
		if err := run(s[0], s[1:]...); err != nil {
			return err
		}
	}
	return nil
}

func cleanup(logf func(string, ...any)) {
	run("ip", "netns", "del", NS)
	run("ip", "link", "del", vethH)
	run("ip", "link", "del", Bridge)
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func output(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).Output()
	return string(out), err
}

// connectIn makes one TCP connection from inside the namespace at nsPath,
// on a thread of its own that never leaves it, and closes it at once. It
// returns nil on a connection and the errno otherwise.
func connectIn(nsPath, ip string, port int) error {
	res := make(chan error, 1)
	go func() {
		// The thread is never unlocked, so it exits with this goroutine
		// instead of returning to the pool inside the namespace.
		runtime.LockOSThread()
		res <- func() error {
			nsfd, err := unix.Open(nsPath, unix.O_RDONLY|unix.O_CLOEXEC, 0)
			if err != nil {
				return err
			}
			defer unix.Close(nsfd)
			if err := unix.Setns(nsfd, unix.CLONE_NEWNET); err != nil {
				return err
			}
			fd, err := unix.Socket(unix.AF_INET, unix.SOCK_STREAM|unix.SOCK_NONBLOCK|unix.SOCK_CLOEXEC, 0)
			if err != nil {
				return err
			}
			defer unix.Close(fd)
			sa := &unix.SockaddrInet4{Port: port}
			copy(sa.Addr[:], net.ParseIP(ip).To4())
			err = unix.Connect(fd, sa)
			if err == nil {
				return nil
			}
			if err != unix.EINPROGRESS {
				return err
			}
			fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLOUT}}
			n, err := unix.Poll(fds, 3000)
			if err != nil {
				return err
			}
			if n == 0 {
				return unix.ETIMEDOUT
			}
			soErr, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_ERROR)
			if err != nil {
				return err
			}
			if soErr != 0 {
				return unix.Errno(soErr)
			}
			return nil
		}()
	}()
	return <-res
}
