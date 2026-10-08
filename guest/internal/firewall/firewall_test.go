package firewall

import (
	"reflect"
	"strings"
	"testing"
)

func TestRulesAreTheContractsInOrder(t *testing.T) {
	want := [][]string{
		{"-N", "LOCALMOST-RELAY"},
		{"-N", "LOCALMOST-INPUT"},
		{"-A", "LOCALMOST-INPUT", "-i", "lo", "-j", "ACCEPT"},
		{"-A", "LOCALMOST-INPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"},
		{"-A", "LOCALMOST-INPUT", "-d", "198.18.0.1/32", "-p", "tcp", "--dport", "3128", "-j", "LOCALMOST-RELAY"},
		{"-A", "LOCALMOST-INPUT", "-p", "tcp", "-j", "REJECT", "--reject-with", "tcp-reset"},
		{"-A", "LOCALMOST-INPUT", "-j", "REJECT", "--reject-with", "icmp-port-unreachable"},
		{"-I", "INPUT", "1", "-j", "LOCALMOST-INPUT"},
		{"-N", "LOCALMOST-NOROUTE"},
		{"-A", "LOCALMOST-NOROUTE", "-o", "lm0", "-p", "tcp", "-j", "REJECT", "--reject-with", "tcp-reset"},
		{"-A", "LOCALMOST-NOROUTE", "-o", "lm0", "-j", "REJECT", "--reject-with", "icmp-net-unreachable"},
		{"-N", "DOCKER-USER"},
		{"-A", "DOCKER-USER", "-j", "LOCALMOST-NOROUTE"},
		{"-I", "OUTPUT", "1", "-j", "LOCALMOST-NOROUTE"},
		{"-A", "LOCALMOST-RELAY", "-i", "docker0", "-j", "ACCEPT"},
	}
	if got := Rules(); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestGoldenIsTheCheckedInCapture(t *testing.T) {
	if !strings.HasPrefix(Golden, "-N LOCALMOST-INPUT\n") || strings.Count(Golden, "\n") != 6 {
		t.Fatalf("golden %q", Golden)
	}
	if !strings.HasPrefix(NoRouteGolden, "-N LOCALMOST-NOROUTE\n") || strings.Count(NoRouteGolden, "\n") != 3 {
		t.Fatalf("no-route golden %q", NoRouteGolden)
	}
}

// listings is `iptables -S` as the guest prints it once dockerd is up.
func listings(override map[string]string) func(string) (string, error) {
	base := map[string]string{
		"LOCALMOST-INPUT":   Golden,
		"INPUT":             "-P INPUT ACCEPT\n-A INPUT -j LOCALMOST-INPUT\n-A INPUT -i docker0 -j ACCEPT\n",
		"LOCALMOST-NOROUTE": NoRouteGolden,
		"OUTPUT":            "-P OUTPUT ACCEPT\n-A OUTPUT -j LOCALMOST-NOROUTE\n",
		"DOCKER-USER":       "-N DOCKER-USER\n-A DOCKER-USER -j LOCALMOST-NOROUTE\n",
		"FORWARD":           "-P FORWARD DROP\n-A FORWARD -j DOCKER-USER\n-A FORWARD -j DOCKER-FORWARD\n",
	}
	return func(chain string) (string, error) {
		if v, ok := override[chain]; ok {
			return v, nil
		}
		return base[chain], nil
	}
}

func TestCheckRules(t *testing.T) {
	if err := CheckRules(listings(nil)); err != nil {
		t.Fatalf("the golden output: %v", err)
	}
	cases := map[string]map[string]string{
		"a missing INPUT rule":              {"LOCALMOST-INPUT": strings.Replace(Golden, "-A LOCALMOST-INPUT -p tcp -j REJECT --reject-with tcp-reset\n", "", 1)},
		"an extra INPUT rule":               {"LOCALMOST-INPUT": Golden + "-A LOCALMOST-INPUT -j ACCEPT\n"},
		"a jump that is not first in INPUT": {"INPUT": "-P INPUT ACCEPT\n-A INPUT -i docker0 -j ACCEPT\n-A INPUT -j LOCALMOST-INPUT\n"},
		"a missing no-route reject":         {"LOCALMOST-NOROUTE": strings.Replace(NoRouteGolden, "-A LOCALMOST-NOROUTE -o lm0 -p tcp -j REJECT --reject-with tcp-reset\n", "", 1)},
		"a no-route chain that accepts":     {"LOCALMOST-NOROUTE": "-N LOCALMOST-NOROUTE\n-A LOCALMOST-NOROUTE -j ACCEPT\n-A LOCALMOST-NOROUTE -j ACCEPT\n"},
		"no jump from OUTPUT":               {"OUTPUT": "-P OUTPUT ACCEPT\n"},
		"DOCKER-USER flushed by dockerd":    {"DOCKER-USER": "-N DOCKER-USER\n-A DOCKER-USER -j RETURN\n"},
		"a FORWARD rule before DOCKER-USER": {"FORWARD": "-P FORWARD DROP\n-A FORWARD -j DOCKER-FORWARD\n-A FORWARD -j DOCKER-USER\n"},
	}
	for name, override := range cases {
		if err := CheckRules(listings(override)); err == nil {
			t.Errorf("%s passed", name)
		}
	}
}

func TestRelayInterfaceForANetwork(t *testing.T) {
	id := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	cases := []struct {
		name string
		n    Network
		want string
		ok   bool
	}{
		{"routable bridge", Network{ID: id, Driver: "bridge"}, "br-0123456789ab", true},
		{"internal bridge", Network{ID: id, Driver: "bridge", Internal: true}, "", false},
		{"not a bridge", Network{ID: id, Driver: "overlay"}, "", false},
		{"the default bridge is static", Network{ID: id, Driver: "bridge", Options: map[string]string{BridgeNameOption: "docker0"}}, "", false},
		{"a custom bridge name fails closed", Network{ID: id, Driver: "bridge", Options: map[string]string{BridgeNameOption: "lo"}}, "", false},
		{"a malformed id", Network{ID: "../x", Driver: "bridge"}, "", false},
	}
	for _, c := range cases {
		got, ok := RelayInterface(c.n)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: got %q %v", c.name, got, ok)
		}
	}
}

func TestTrackerAddsOnCreateAndRemovesOnDestroy(t *testing.T) {
	id := strings.Repeat("ab", 32)
	var tr Tracker
	add := tr.Created(Network{ID: id, Driver: "bridge"})
	if !reflect.DeepEqual(add, [][]string{RelayRule("-A", "br-abababababab")}) {
		t.Fatalf("create: %v", add)
	}
	if again := tr.Created(Network{ID: id, Driver: "bridge"}); len(again) != 0 {
		t.Fatal("a second create of the same network added a second rule")
	}
	del, ok := tr.Destroyed(id)
	if !ok || !reflect.DeepEqual(del, RelayRule("-D", "br-abababababab")) {
		t.Fatalf("destroy: %v %v", del, ok)
	}
	if _, ok := tr.Destroyed(id); ok {
		t.Fatal("a second destroy deleted again")
	}
	if got := tr.Created(Network{ID: id, Driver: "bridge", Internal: true}); len(got) != 0 {
		t.Fatal("an internal network got a relay rule")
	}
}
