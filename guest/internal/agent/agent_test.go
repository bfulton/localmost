package agent_test

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/bfulton/localmost/guest/internal/agent"
	"github.com/bfulton/localmost/guest/internal/agenttest"
)

const sharePath = "/Users/me/.localmost/runner/sandbox/3-0123456789ab/_work"

var cid = strings.Repeat("c0", 32)

func configureJob() string {
	return `{"v":1,"id":2,"op":"configure","vmId":"3-0123456789ab","mode":"job","timeUnixMs":1790000000000,` +
		`"share":{"tag":"work","mountPath":"` + sharePath + `","nonceFile":".localmost-share"},` +
		`"rosetta":true,"relay":{"address":"198.18.0.1","port":3128,"vsockPort":3128}}`
}

func do(t *testing.T, a *agent.Agent, line string, local bool) map[string]any {
	t.Helper()
	out, after := a.Handle([]byte(line), local)
	if after != nil {
		after()
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("answer %q: %v", out, err)
	}
	return m
}

func code(m map[string]any) string {
	c, _ := m["code"].(string)
	return c
}

func TestHello(t *testing.T) {
	a := agent.New(&agenttest.Fake{})
	m := do(t, a, `{"v":1,"id":1,"op":"hello"}`, false)
	if m["ok"] != true || m["agentProtocol"] != float64(1) || m["guestVersion"] != "2026.10.0" || m["id"] != float64(1) {
		t.Fatalf("hello %v", m)
	}
}

func TestUnknownOpIsRefused(t *testing.T) {
	a := agent.New(&agenttest.Fake{})
	if m := do(t, a, `{"v":1,"id":1,"op":"exec","cmd":"sh"}`, false); code(m) != "E_UNKNOWN_OP" {
		t.Fatalf("got %v", m)
	}
	// binds-for is guest-local; on the control socket it does not exist.
	if m := do(t, a, `{"v":1,"id":1,"op":"binds-for","container":"`+cid+`"}`, false); code(m) != "E_UNKNOWN_OP" {
		t.Fatalf("binds-for on vsock: %v", m)
	}
	// And the local socket serves nothing else.
	if m := do(t, a, `{"v":1,"id":1,"op":"hello"}`, true); code(m) != "E_UNKNOWN_OP" {
		t.Fatalf("hello on the local socket: %v", m)
	}
}

func TestConfigureRunsTheStepsInOrderAndAnswers(t *testing.T) {
	f := &agenttest.Fake{}
	a := agent.New(f)
	m := do(t, a, configureJob(), false)
	if m["ok"] != true {
		t.Fatalf("configure %v", m)
	}
	want := []string{"clock", "disk", "share", "rosetta", "network", "dockerd", "selftest"}
	if got := f.CallsSoFar(); !reflect.DeepEqual(got, want) {
		t.Fatalf("steps %v, want %v", got, want)
	}
	if m["disk"] != "formatted" || m["nonce"] != "0123456789abcdef0123456789abcdef" || m["rosetta"] != "ok" {
		t.Fatalf("answer %v", m)
	}
	st := m["selftest"].(map[string]any)
	for _, k := range []string{"rules", "internalNoRelay", "internalForgedRejected", "gatewayRejected", "bridgeReachesRelay"} {
		if st[k] != true {
			t.Fatalf("selftest %v", st)
		}
	}
}

func TestSecondConfigureIsRefusedEvenAfterAFailure(t *testing.T) {
	a := agent.New(&agenttest.Fake{DockerErr: errors.New("no ping")})
	if m := do(t, a, configureJob(), false); code(m) != "E_DOCKERD" {
		t.Fatalf("first: %v", m)
	}
	if m := do(t, a, configureJob(), false); code(m) != "E_CONFIGURED" {
		t.Fatalf("second: %v", m)
	}
}

func TestConfigureStopsAtTheFirstFailureWithItsCode(t *testing.T) {
	cases := []struct {
		name  string
		fake  *agenttest.Fake
		code  string
		calls []string
	}{
		{"disk error", &agenttest.Fake{DiskErr: errors.New("mke2fs")}, "E_DISK", []string{"clock", "disk"}},
		{"corrupt disk", &agenttest.Fake{Disk: agent.DiskCorrupt}, "E_DISK", []string{"clock", "disk"}},
		{"share mount", &agenttest.Fake{ShareErr: errors.New("virtiofs")}, "E_SHARE_MOUNT", []string{"clock", "disk", "share"}},
		{"firewall", &agenttest.Fake{NetworkErr: errors.New("iptables")}, "E_SELFTEST", []string{"clock", "disk", "share", "rosetta", "network"}},
		{"dockerd", &agenttest.Fake{DockerErr: errors.New("no ping")}, "E_DOCKERD", []string{"clock", "disk", "share", "rosetta", "network", "dockerd"}},
		{"selftest", &agenttest.Fake{Selftest: &agent.Selftest{Rules: true, InternalNoRelay: true, InternalForgedRejected: false, GatewayRejected: true, BridgeReachesRelay: true}}, "E_SELFTEST", []string{"clock", "disk", "share", "rosetta", "network", "dockerd", "selftest"}},
	}
	for _, c := range cases {
		a := agent.New(c.fake)
		m := do(t, a, configureJob(), false)
		if code(m) != c.code || !reflect.DeepEqual(c.fake.CallsSoFar(), c.calls) {
			t.Errorf("%s: %v after %v", c.name, m, c.fake.CallsSoFar())
		}
	}
	a := agent.New(&agenttest.Fake{Disk: agent.DiskCorrupt})
	if m := do(t, a, configureJob(), false); m["disk"] != "corrupt" {
		t.Errorf("a corrupt disk's refusal does not say disk: corrupt: %v", m)
	}
}

func TestASharePathOutsideTheMountRootsIsRefused(t *testing.T) {
	f := &agenttest.Fake{}
	a := agent.New(f)
	line := strings.Replace(configureJob(), sharePath, "/var/lib/docker/_work", 1)
	if m := do(t, a, line, false); code(m) != "E_SHARE_PATH" {
		t.Fatalf("got %v", m)
	}
	if got := f.CallsSoFar(); !reflect.DeepEqual(got, []string{"clock", "disk"}) {
		t.Fatalf("steps %v", got)
	}
}

func TestRosettaNeverFailsConfigure(t *testing.T) {
	a := agent.New(&agenttest.Fake{Rosetta: "broken"})
	if m := do(t, a, configureJob(), false); m["ok"] != true || m["rosetta"] != "broken" {
		t.Fatalf("got %v", m)
	}
}

func TestRefreshConfigureHasNoShareAndChecksOnlyTheRules(t *testing.T) {
	f := &agenttest.Fake{}
	a := agent.New(f)
	m := do(t, a, `{"v":1,"id":2,"op":"configure","vmId":"0-0123456789ab","mode":"refresh","timeUnixMs":1,"rosetta":false}`, false)
	if m["ok"] != true || m["nonce"] != nil || m["rosetta"] != "absent" {
		t.Fatalf("got %v", m)
	}
	if got := f.CallsSoFar(); !reflect.DeepEqual(got, []string{"clock", "disk", "rosetta", "network", "dockerd", "selftest"}) {
		t.Fatalf("steps %v", got)
	}
	approve := `{"v":1,"id":3,"op":"approve-binds","container":"` + cid + `","binds":[]}`
	if m := do(t, a, approve, false); code(m) != "E_BINDS" {
		t.Fatalf("approve-binds in a refresh VM: %v", m)
	}
}

func approveLine(container string, binds string) string {
	return `{"v":1,"id":3,"op":"approve-binds","container":"` + container + `","binds":` + binds + `}`
}

func TestApproveBindsAndBindsFor(t *testing.T) {
	a := agent.New(&agenttest.Fake{})
	binds := `[{"source":"` + sharePath + `/r/r/data","destination":"/data","readOnly":true}]`
	if m := do(t, a, approveLine(cid, binds), false); code(m) != "E_NOT_CONFIGURED" {
		t.Fatalf("before configure: %v", m)
	}
	do(t, a, configureJob(), false)
	if m := do(t, a, approveLine(cid, binds), false); m["ok"] != true {
		t.Fatalf("approve: %v", m)
	}
	if m := do(t, a, approveLine(cid, binds), false); code(m) != "E_BINDS" {
		t.Fatalf("a second approval for one container: %v", m)
	}
	m := do(t, a, `{"v":1,"id":1,"op":"binds-for","container":"`+cid+`"}`, true)
	var want any
	json.Unmarshal([]byte(binds), &want)
	if !reflect.DeepEqual(m["binds"], want) {
		t.Fatalf("binds-for: %v", m["binds"])
	}
	other := strings.Repeat("d1", 32)
	if m := do(t, a, `{"v":1,"id":1,"op":"binds-for","container":"`+other+`"}`, true); m["ok"] != true || m["binds"] != nil {
		t.Fatalf("binds-for an unknown container: %v", m)
	}
}

func TestApproveBindsRefusesSourcesOffTheShare(t *testing.T) {
	a := agent.New(&agenttest.Fake{})
	do(t, a, configureJob(), false)
	for i, src := range []string{"/etc", sharePath + "2/x", sharePath + "/../x", sharePath + "/a/"} {
		c := fmt.Sprintf("%064x", i)
		binds := `[{"source":"` + src + `","destination":"/d","readOnly":false}]`
		if m := do(t, a, approveLine(c, binds), false); code(m) != "E_BINDS" {
			t.Errorf("%s: %v", src, m)
		}
	}
}

func TestApproveBindsLimitsComeFromTheProtocol(t *testing.T) {
	a := agent.New(&agenttest.Fake{})
	do(t, a, configureJob(), false)
	many := make([]string, 65)
	for i := range many {
		many[i] = `{"source":"` + sharePath + `","destination":"/d","readOnly":false}`
	}
	if m := do(t, a, approveLine(cid, "["+strings.Join(many, ",")+"]"), false); code(m) != "E_BINDS" {
		t.Fatalf("65 binds: %v", m)
	}
}

func TestShutdownAnswersFirst(t *testing.T) {
	f := &agenttest.Fake{}
	a := agent.New(f)
	out, after := a.Handle([]byte(`{"v":1,"id":9,"op":"shutdown"}`), false)
	if !strings.Contains(string(out), `"ok":true`) || after == nil {
		t.Fatalf("got %q", out)
	}
	if len(f.CallsSoFar()) != 0 {
		t.Fatal("shutdown ran before the answer was written")
	}
	after()
	if got := f.CallsSoFar(); !reflect.DeepEqual(got, []string{"shutdown"}) {
		t.Fatalf("calls %v", got)
	}
}

func TestServeClosesOnAnOverlongLineAndAnswersInOrder(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go agenttest.Serve(l, &agenttest.Fake{})
	c, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(10 * time.Second))
	fmt.Fprintf(c, "%s\n%s\n", `{"v":1,"id":1,"op":"hello"}`, `{"v":1,"id":2,"op":"status"}`)
	r := bufio.NewReader(c)
	for _, id := range []string{`"id":1`, `"id":2`} {
		line, err := r.ReadString('\n')
		if err != nil || !strings.Contains(line, id) {
			t.Fatalf("answer %q, %v; want %s", line, err, id)
		}
	}
	c.Write([]byte(strings.Repeat("x", 64*1024+1) + "\n"))
	line, _ := r.ReadString('\n')
	if !strings.Contains(line, "E_PROTO") {
		t.Fatalf("overlong line answered %q", line)
	}
	if _, err := r.ReadString('\n'); err == nil {
		t.Fatal("the connection stayed open after an overlong line")
	}
}
