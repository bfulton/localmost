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
}

func TestCheckRules(t *testing.T) {
	input := "-P INPUT ACCEPT\n-A INPUT -j LOCALMOST-INPUT\n-A INPUT -i docker0 -j ACCEPT\n"
	if err := CheckRules(Golden, input); err != nil {
		t.Fatalf("the golden output: %v", err)
	}
	missing := strings.Replace(Golden, "-A LOCALMOST-INPUT -p tcp -j REJECT --reject-with tcp-reset\n", "", 1)
	if err := CheckRules(missing, input); err == nil {
		t.Fatal("a missing rule passed")
	}
	extra := Golden + "-A LOCALMOST-INPUT -j ACCEPT\n"
	if err := CheckRules(extra, input); err == nil {
		t.Fatal("an extra rule passed")
	}
	notFirst := "-P INPUT ACCEPT\n-A INPUT -i docker0 -j ACCEPT\n-A INPUT -j LOCALMOST-INPUT\n"
	if err := CheckRules(Golden, notFirst); err == nil {
		t.Fatal("a jump that is not first in INPUT passed")
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
	add, ok := tr.Created(Network{ID: id, Driver: "bridge"})
	if !ok || !reflect.DeepEqual(add, RelayRule("-A", "br-abababababab")) {
		t.Fatalf("create: %v %v", add, ok)
	}
	if _, ok := tr.Created(Network{ID: id, Driver: "bridge"}); ok {
		t.Fatal("a second create of the same network added a second rule")
	}
	del, ok := tr.Destroyed(id)
	if !ok || !reflect.DeepEqual(del, RelayRule("-D", "br-abababababab")) {
		t.Fatalf("destroy: %v %v", del, ok)
	}
	if _, ok := tr.Destroyed(id); ok {
		t.Fatal("a second destroy deleted again")
	}
	if _, ok := tr.Created(Network{ID: id, Driver: "bridge", Internal: true}); ok {
		t.Fatal("an internal network got a relay rule")
	}
}
