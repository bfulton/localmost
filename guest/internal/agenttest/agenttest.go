// Package agenttest is the fake guest agent (contract §8): the real
// protocol handling of package agent over a Platform that touches nothing.
// WP-B can run it on the Mac behind a unix socket (see fakeagent/) to
// check the helper's splicing, and the agent's own tests use it.
package agenttest

import (
	"errors"
	"net"
	"sync"

	"github.com/bfulton/localmost/guest/internal/agent"
)

// Fake is a Platform whose answers the test chooses. The zero value
// succeeds at every step with plausible values.
type Fake struct {
	mu    sync.Mutex
	Calls []string

	Disk        string // "" means formatted
	DiskErr     error
	Nonce       string
	ShareErr    error
	Rosetta     string // "" means ok when enabled
	NetworkErr  error
	DockerErr   error
	Selftest    *agent.Selftest
	ClockErr    error
	ShutdownHit chan struct{}
}

func (f *Fake) call(name string) {
	f.mu.Lock()
	f.Calls = append(f.Calls, name)
	f.mu.Unlock()
}

// CallsSoFar returns a copy of the calls made so far.
func (f *Fake) CallsSoFar() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.Calls...)
}

func (f *Fake) Hello() (string, string) { return "2026.10.0", "6.18.54-0-virt" }

func (f *Fake) SetClock(int64) error { f.call("clock"); return f.ClockErr }

func (f *Fake) PrepareDisk() (string, error) {
	f.call("disk")
	if f.Disk == "" {
		return agent.DiskFormatted, f.DiskErr
	}
	return f.Disk, f.DiskErr
}

func (f *Fake) MountShare(top, mountPath, nonceFile string) (string, error) {
	f.call("share")
	if f.Nonce == "" {
		return "0123456789abcdef0123456789abcdef", f.ShareErr
	}
	return f.Nonce, f.ShareErr
}

func (f *Fake) SetupRosetta(enabled bool) string {
	f.call("rosetta")
	if !enabled {
		return "absent"
	}
	if f.Rosetta == "" {
		return "ok"
	}
	return f.Rosetta
}

func (f *Fake) SetupNetwork(job bool) error { f.call("network"); return f.NetworkErr }

func (f *Fake) StartDockerd(job bool) (agent.DockerVersion, error) {
	f.call("dockerd")
	return agent.DockerVersion{Version: "29.5.3", APIVersion: "1.54", MinAPIVersion: "1.40"}, f.DockerErr
}

func (f *Fake) SelfTest(job bool) agent.Selftest {
	f.call("selftest")
	if f.Selftest != nil {
		return *f.Selftest
	}
	return agent.Selftest{Rules: true, InternalNoRelay: job, InternalForgedRejected: job, GatewayRejected: job, BridgeReachesRelay: job, OutsideRejected: job}
}

func (f *Fake) DockerdRunning() bool { return true }

func (f *Fake) UptimeMs() int64 { return 1234 }

// Shutdown records the call and signals ShutdownHit; the real one never
// returns.
func (f *Fake) Shutdown() {
	f.call("shutdown")
	if f.ShutdownHit != nil {
		close(f.ShutdownHit)
	}
}

// Serve runs a fake agent on l until l is closed: every connection is a
// control connection (vsock 1025's protocol).
func Serve(l net.Listener, f *Fake) error {
	a := agent.New(f)
	for {
		c, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go a.Serve(c, false)
	}
}
