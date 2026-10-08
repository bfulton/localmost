package firewall

import (
	"reflect"
	"strings"
	"testing"
)

func TestSyncRebuildsTheRelayChainFromTheListedNetworks(t *testing.T) {
	a, b, c := strings.Repeat("aa", 32), strings.Repeat("bb", 32), strings.Repeat("cc", 32)
	var tr Tracker
	tr.Created(Network{ID: a, Driver: "bridge"})
	// Across a reconnect, a was destroyed and b and c were created; the
	// destroy event was missed.
	got := tr.Sync([]Network{
		{ID: strings.Repeat("dd", 32), Name: "bridge", Driver: "bridge", Options: map[string]string{BridgeNameOption: "docker0"}},
		{ID: b, Driver: "bridge"},
		{ID: c, Driver: "bridge", Internal: true},
	})
	want := [][]string{
		{"-F", "LOCALMOST-RELAY"},
		RelayRule("-A", "docker0"),
		RelayRule("-A", "br-bbbbbbbbbbbb"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	// The tracker now knows b and not a.
	if _, ok := tr.Destroyed(a); ok {
		t.Fatal("a missed network still has a rule to delete")
	}
	if del, ok := tr.Destroyed(b); !ok || !reflect.DeepEqual(del, RelayRule("-D", "br-bbbbbbbbbbbb")) {
		t.Fatalf("b: %v %v", del, ok)
	}
}

func TestCreatedDeletesAStaleRuleForTheSameInterface(t *testing.T) {
	old, internal, routable := strings.Repeat("ab", 32), strings.Repeat("cd", 32), strings.Repeat("ef", 32)
	var tr Tracker
	tr.Created(Network{ID: old, Driver: "bridge"})
	// A missed destroy left old's rule; a new internal network now uses
	// its bridge name.
	got := tr.Created(Network{ID: internal, Driver: "bridge", Internal: true, Options: map[string]string{BridgeNameOption: "br-abababababab"}})
	if want := [][]string{RelayRule("-D", "br-abababababab")}; !reflect.DeepEqual(got, want) {
		t.Fatalf("internal: got %v", got)
	}
	if _, ok := tr.Destroyed(old); ok {
		t.Fatal("the stale rule is still tracked")
	}
	// A routable network gets its rule; a second create changes nothing.
	if got := tr.Created(Network{ID: routable, Driver: "bridge"}); !reflect.DeepEqual(got, [][]string{RelayRule("-A", "br-efefefefefef")}) {
		t.Fatalf("routable: got %v", got)
	}
	if got := tr.Created(Network{ID: routable, Driver: "bridge"}); len(got) != 0 {
		t.Fatalf("second create: got %v", got)
	}
}
