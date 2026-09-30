package agent_test

import (
	"errors"
	"fmt"
	"testing"

	"github.com/bfulton/localmost/guest/internal/agent"
	"github.com/bfulton/localmost/guest/internal/agenttest"
)

func TestReadyOnlyOnceEveryConfigureStepPassed(t *testing.T) {
	failed := &agent.Selftest{Rules: true, InternalNoRelay: true, InternalForgedRejected: false, GatewayRejected: true, BridgeReachesRelay: true}
	cases := []struct {
		name  string
		fake  *agenttest.Fake
		ready bool
	}{
		{"every step passed", &agenttest.Fake{}, true},
		{"the firewall could not be applied", &agenttest.Fake{NetworkErr: errors.New("iptables")}, false},
		{"dockerd did not start", &agenttest.Fake{DockerErr: errors.New("no ping")}, false},
		// dockerd is running here, behind a firewall that failed its test.
		{"the self-test failed", &agenttest.Fake{Selftest: failed}, false},
	}
	for _, c := range cases {
		a := agent.New(c.fake)
		if a.Ready() {
			t.Fatalf("%s: ready before configure", c.name)
		}
		do(t, a, configureJob(), false)
		if a.Ready() != c.ready {
			t.Errorf("%s: ready is %v", c.name, a.Ready())
		}
	}
}

func TestTheFakeReportsTheDaemonTheGuestShips(t *testing.T) {
	// WP-B and WP-C test against the fake: it answers what dockerd 29.5.3
	// answers (contract §4.1).
	m := do(t, agent.New(&agenttest.Fake{}), configureJob(), false)
	d, _ := m["docker"].(map[string]any)
	if d["version"] != "29.5.3" || d["apiVersion"] != "1.54" || d["minApiVersion"] != "1.40" {
		t.Fatalf("docker %v", d)
	}
}

func TestAStepFiveFailureHasItsOwnMessage(t *testing.T) {
	// Step 5 answers E_SELFTEST (contract §3.4), with no selftest field.
	a := agent.New(&agenttest.Fake{NetworkErr: errors.New("iptables")})
	m := do(t, a, configureJob(), false)
	if code(m) != "E_SELFTEST" || m["selftest"] != nil {
		t.Fatalf("got %v", m)
	}
}

func TestForgetFreesAContainersApprovals(t *testing.T) {
	a := agent.New(&agenttest.Fake{})
	do(t, a, configureJob(), false)
	approve := func(id string) map[string]any {
		return do(t, a, `{"v":1,"id":3,"op":"approve-binds","container":"`+id+`","binds":[]}`, false)
	}
	ids := make([]string, agent.MaxContainers)
	for i := range ids {
		ids[i] = fmt.Sprintf("%064x", i+1)
		if m := approve(ids[i]); m["ok"] != true {
			t.Fatalf("approve %d: %v", i, m)
		}
	}
	extra := fmt.Sprintf("%064x", agent.MaxContainers+1)
	if m := approve(extra); code(m) != "E_BINDS" {
		t.Fatalf("past the cap: %v", m)
	}
	a.Forget(ids[0])
	if m := do(t, a, `{"v":1,"id":4,"op":"binds-for","container":"`+ids[0]+`"}`, true); m["binds"] != nil {
		t.Fatalf("a forgotten container still has binds: %v", m)
	}
	if m := approve(extra); m["ok"] != true {
		t.Fatalf("after a container was forgotten: %v", m)
	}
}
