// Package agent is lm-agent's protocol handling (contract §3.4): the ops,
// their order and limits, configure's steps, and the bind approvals. What
// each step does to the guest is behind Platform, so that this package is
// portable: lm-agent supplies the Linux platform, and agenttest a fake one.
package agent

import (
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"sync"

	"github.com/bfulton/localmost/guest/internal/proto"
	"github.com/bfulton/localmost/guest/internal/share"
)

// AgentVersion is lm-agent's own version, reported by hello.
const AgentVersion = "0.1.0"

// MaxContainers bounds how many containers' approvals the agent holds at
// once. A container's approvals are dropped when Docker destroys it, so the
// bound is on containers that exist, not on how many a job ever creates.
const MaxContainers = 4096

// DockerVersion is what configure reports about dockerd.
type DockerVersion struct {
	Version       string `json:"version"`
	APIVersion    string `json:"apiVersion"`
	MinAPIVersion string `json:"minApiVersion"`
}

// Selftest is configure's self-test result (contract §3.6).
type Selftest struct {
	Rules                  bool `json:"rules"`
	InternalNoRelay        bool `json:"internalNoRelay"`
	InternalForgedRejected bool `json:"internalForgedRejected"`
	GatewayRejected        bool `json:"gatewayRejected"`
	BridgeReachesRelay     bool `json:"bridgeReachesRelay"`
}

// Passed reports whether every check ran and passed. In refresh mode only
// the rules are checked.
func (s Selftest) Passed(job bool) bool {
	if !job {
		return s.Rules
	}
	return s.Rules && s.InternalNoRelay && s.InternalForgedRejected && s.GatewayRejected && s.BridgeReachesRelay
}

// Disk states configure reports.
const (
	DiskFormatted = "formatted"
	DiskExisting  = "existing"
	DiskCorrupt   = "corrupt"
)

// Platform is what configure and the other ops do to the guest.
type Platform interface {
	// Hello returns the guest version and the kernel release.
	Hello() (guestVersion, kernel string)
	SetClock(unixMs int64) error
	// PrepareDisk formats or checks /dev/vdb and mounts it on
	// /var/lib/docker. It returns DiskCorrupt with a nil error when the
	// disk has errors.
	PrepareDisk() (string, error)
	// MountShare mounts the share at mountPath under a tmpfs on /top and
	// returns what the nonce file holds (at most 64 bytes).
	MountShare(top, mountPath, nonceFile string) (string, error)
	// SetupRosetta mounts and registers Rosetta when enabled: "ok",
	// "absent" or "broken"; it never fails configure.
	SetupRosetta(enabled bool) string
	// SetupNetwork applies the firewall, and in job mode makes lm0 and
	// starts the relay.
	SetupNetwork(job bool) error
	// StartDockerd starts dockerd and waits for /_ping; in job mode it
	// then follows network events for LOCALMOST-RELAY. On failure the
	// error carries the last log lines.
	StartDockerd(job bool) (DockerVersion, error)
	SelfTest(job bool) Selftest
	DockerdRunning() bool
	UptimeMs() int64
	// Shutdown stops dockerd, syncs, unmounts the data disk and exits the
	// agent, which powers the guest off. It does not return.
	Shutdown()
}

// Agent holds the state of one guest's agent.
type Agent struct {
	P Platform

	mu         sync.Mutex
	configured bool
	ready      bool
	mode       string
	sharePath  string
	binds      map[string][]proto.Bind
}

// New returns an agent over p.
func New(p Platform) *Agent { return &Agent{P: p, binds: map[string][]proto.Bind{}} }

// Ready reports whether configure has run every step and the self-test
// passed. Until then the Docker API on vsock 2375 stays closed, so that a
// daemon behind a firewall that failed never answers the host.
func (a *Agent) Ready() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.ready
}

// Forget drops a container's approvals once Docker has destroyed it.
func (a *Agent) Forget(container string) {
	a.mu.Lock()
	delete(a.binds, container)
	a.mu.Unlock()
}

// Serve handles one connection's requests in order until it closes. local
// is the guest-local socket, where only binds-for is served.
func (a *Agent) Serve(rw io.ReadWriteCloser, local bool) {
	defer rw.Close()
	r := proto.NewLineReader(rw)
	for {
		line, err := r.Next()
		if errors.Is(err, proto.ErrLineTooLong) {
			rw.Write(proto.Refuse(0, &proto.Error{Code: proto.CodeProto, Message: "request longer than 64 KiB"}))
			return
		}
		if err != nil {
			return
		}
		out, after := a.Handle(line, local)
		if _, err := rw.Write(out); err != nil {
			return
		}
		if after != nil {
			after()
		}
	}
}

// Handle answers one request line. `after`, when set, runs once the answer
// has been written (shutdown's answer comes first).
func (a *Agent) Handle(line []byte, local bool) ([]byte, func()) {
	req, perr := proto.ParseRequest(line)
	if perr != nil {
		return proto.Refuse(perr.ID, perr), nil
	}
	refuse := func(e *proto.Error) ([]byte, func()) { return proto.Refuse(req.ID, e), nil }
	unknown := &proto.Error{Code: proto.CodeUnknownOp, Message: fmt.Sprintf("unknown op %q", sanitize(req.Op))}
	if local {
		if req.Op != "binds-for" {
			return refuse(unknown)
		}
		container, e := proto.ParseBindsFor(req)
		if e != nil {
			return refuse(e)
		}
		a.mu.Lock()
		binds, ok := a.binds[container]
		a.mu.Unlock()
		if !ok {
			return proto.Answer(req.ID, map[string]any{"binds": nil}), nil
		}
		return proto.Answer(req.ID, map[string]any{"binds": binds}), nil
	}
	switch req.Op {
	case "hello":
		if e := proto.CheckEmpty(req); e != nil {
			return refuse(e)
		}
		gv, kernel := a.P.Hello()
		return proto.Answer(req.ID, map[string]any{"agent": AgentVersion, "guestVersion": gv, "kernel": kernel, "agentProtocol": 1}), nil
	case "configure":
		c, e := proto.ParseConfigure(req)
		if e != nil {
			return refuse(e)
		}
		fields, e := a.configure(c)
		if e != nil {
			return refuse(e)
		}
		return proto.Answer(req.ID, fields), nil
	case "approve-binds":
		container, binds, e := proto.ParseApproveBinds(req)
		if e != nil {
			return refuse(e)
		}
		if e := a.approve(container, binds); e != nil {
			return refuse(e)
		}
		return proto.Answer(req.ID, nil), nil
	case "set-time":
		ms, e := proto.ParseSetTime(req)
		if e != nil {
			return refuse(e)
		}
		if err := a.P.SetClock(ms); err != nil {
			return refuse(&proto.Error{Code: proto.CodeProto, Message: "could not set the clock: " + err.Error()})
		}
		return proto.Answer(req.ID, nil), nil
	case "status":
		if e := proto.CheckEmpty(req); e != nil {
			return refuse(e)
		}
		state := "exited"
		if a.P.DockerdRunning() {
			state = "running"
		}
		return proto.Answer(req.ID, map[string]any{"dockerd": state, "uptimeMs": a.P.UptimeMs()}), nil
	case "shutdown":
		if e := proto.CheckEmpty(req); e != nil {
			return refuse(e)
		}
		return proto.Answer(req.ID, nil), a.P.Shutdown
	}
	return refuse(unknown)
}

func fail(code, format string, args ...any) *proto.Error {
	return &proto.Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// configure runs the contract's steps in order and stops at the first
// failure. It is accepted once, whether or not it succeeds.
func (a *Agent) configure(c *proto.Configure) (map[string]any, *proto.Error) {
	a.mu.Lock()
	if a.configured {
		a.mu.Unlock()
		return nil, fail(proto.CodeConfigured, "configure was already accepted")
	}
	a.configured = true
	a.mode = c.Mode
	a.mu.Unlock()
	job := c.Mode == "job"

	if err := a.P.SetClock(c.TimeUnixMs); err != nil {
		return nil, fail(proto.CodeProto, "could not set the clock: %v", err)
	}
	disk, err := a.P.PrepareDisk()
	if err != nil {
		return nil, fail(proto.CodeDisk, "the data disk could not be prepared: %v", err)
	}
	if disk == DiskCorrupt {
		e := fail(proto.CodeDisk, "the data disk has errors")
		e.Extra = map[string]any{"disk": DiskCorrupt}
		return nil, e
	}
	fields := map[string]any{"disk": disk}
	if job {
		top, err := share.CheckMountPath(c.Share.MountPath)
		if err != nil {
			return nil, fail(proto.CodeSharePath, "%v", err)
		}
		nonce, err := a.P.MountShare(top, c.Share.MountPath, c.Share.NonceFile)
		if err != nil {
			return nil, fail(proto.CodeShareMount, "%v", err)
		}
		fields["nonce"] = nonce
		a.mu.Lock()
		a.sharePath = c.Share.MountPath
		a.mu.Unlock()
	}
	fields["rosetta"] = a.P.SetupRosetta(job && c.Rosetta)
	// A failure to apply the firewall or make lm0 answers E_SELFTEST with
	// no selftest field (contract §3.4 step 5): either way the firewall
	// cannot be trusted.
	if err := a.P.SetupNetwork(job); err != nil {
		return nil, fail(proto.CodeSelftest, "the firewall could not be applied: %v", err)
	}
	dv, err := a.P.StartDockerd(job)
	if err != nil {
		return nil, fail(proto.CodeDockerd, "%v", err)
	}
	fields["docker"] = dv
	st := a.P.SelfTest(job)
	fields["selftest"] = st
	if !st.Passed(job) {
		e := fail(proto.CodeSelftest, "the firewall self-test failed: %+v", st)
		e.Extra = map[string]any{"selftest": st}
		return nil, e
	}
	a.mu.Lock()
	a.ready = true
	a.mu.Unlock()
	return fields, nil
}

// approve records one container's approved binds. It needs a configured
// job VM, takes each container once, and refuses a source that is not on
// the share.
func (a *Agent) approve(container string, binds []proto.Bind) *proto.Error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.ready {
		return fail(proto.CodeNotConfigured, "the VM is not configured")
	}
	if a.mode != "job" {
		return fail(proto.CodeBinds, "a refresh VM has no share")
	}
	if _, dup := a.binds[container]; dup {
		return fail(proto.CodeBinds, "container %s already has approved binds", container[:12])
	}
	if len(a.binds) >= MaxContainers {
		return fail(proto.CodeBinds, "too many containers")
	}
	for i, b := range binds {
		if b.Source != path.Clean(b.Source) || !(b.Source == a.sharePath || strings.HasPrefix(b.Source, a.sharePath+"/")) {
			return fail(proto.CodeBinds, "bind %d's source is not a clean path on the share", i)
		}
	}
	a.binds[container] = binds
	return nil
}

// sanitize keeps a guest-echoed string printable and short.
func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		if b.Len() >= 64 {
			break
		}
		if r >= 0x20 && r < 0x7f {
			b.WriteRune(r)
		}
	}
	return b.String()
}
