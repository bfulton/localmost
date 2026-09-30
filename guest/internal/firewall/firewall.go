// Package firewall is the guest's INPUT firewall (contract §3.6): the rules
// applied before dockerd starts, the golden form the self-test compares
// against, and the LOCALMOST-RELAY chain kept in step with Docker's
// network events. Only the bridges of routable networks may reach the
// relay address; everything else sent to the guest's root namespace is
// rejected at once.
package firewall

import (
	_ "embed"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// Golden is `iptables -S LOCALMOST-INPUT` as the pinned iptables prints it,
// captured verbatim in the guest.
//
//go:embed testdata/localmost-input.txt
var Golden string

// BridgeNameOption is the network option that names a bridge's interface.
const BridgeNameOption = "com.docker.network.bridge.name"

// Rules returns the iptables argument lists applied, in order, before
// dockerd starts. The last opens the relay to the default bridge.
func Rules() [][]string {
	return [][]string{
		{"-N", "LOCALMOST-RELAY"},
		{"-N", "LOCALMOST-INPUT"},
		{"-A", "LOCALMOST-INPUT", "-i", "lo", "-j", "ACCEPT"},
		{"-A", "LOCALMOST-INPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"},
		{"-A", "LOCALMOST-INPUT", "-d", "198.18.0.1/32", "-p", "tcp", "--dport", "3128", "-j", "LOCALMOST-RELAY"},
		{"-A", "LOCALMOST-INPUT", "-p", "tcp", "-j", "REJECT", "--reject-with", "tcp-reset"},
		{"-A", "LOCALMOST-INPUT", "-j", "REJECT", "--reject-with", "icmp-port-unreachable"},
		{"-I", "INPUT", "1", "-j", "LOCALMOST-INPUT"},
		RelayRule("-A", "docker0"),
	}
}

// RelayRule adds ("-A") or deletes ("-D") the rule that lets one bridge
// reach the relay.
func RelayRule(action, iface string) []string {
	return []string{action, "LOCALMOST-RELAY", "-i", iface, "-j", "ACCEPT"}
}

func lines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimRight(l, " \r"); l != "" {
			out = append(out, l)
		}
	}
	return out
}

// CheckRules compares `iptables -S LOCALMOST-INPUT` with the golden output,
// line for line, and checks that `iptables -S INPUT` jumps to it first.
func CheckRules(chainOut, inputOut string) error {
	got, want := lines(chainOut), lines(Golden)
	if len(got) != len(want) {
		return fmt.Errorf("LOCALMOST-INPUT has %d lines, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			return fmt.Errorf("LOCALMOST-INPUT line %d is %q, want %q", i+1, got[i], want[i])
		}
	}
	var rules []string
	for _, l := range lines(inputOut) {
		if strings.HasPrefix(l, "-A INPUT ") {
			rules = append(rules, l)
		}
	}
	if len(rules) == 0 || rules[0] != "-A INPUT -j LOCALMOST-INPUT" {
		return fmt.Errorf("INPUT does not start with the jump to LOCALMOST-INPUT")
	}
	return nil
}

var networkIDRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Network is what the agent reads from a network's inspect answer.
type Network struct {
	ID       string            `json:"Id"`
	Name     string            `json:"Name"`
	Driver   string            `json:"Driver"`
	Internal bool              `json:"Internal"`
	Options  map[string]string `json:"Options"`
}

// RelayInterface returns the bridge interface that should reach the relay
// for a network: a routable (not internal) bridge network with Docker's own
// interface name, br-<first 12 of its id>. The default bridge (docker0) is
// in the rules from the start. A bridge given a custom name gets no rule,
// so it fails closed; so does anything with a malformed id.
func RelayInterface(n Network) (string, bool) {
	if n.Driver != "bridge" || n.Internal || !networkIDRe.MatchString(n.ID) {
		return "", false
	}
	if name, set := n.Options[BridgeNameOption]; set && name != "br-"+n.ID[:12] {
		return "", false
	}
	return "br-" + n.ID[:12], true
}

// Tracker remembers which network each relay rule belongs to.
type Tracker struct {
	mu    sync.Mutex
	rules map[string]string // network id -> interface
}

// Created returns the rule to add for a new network, if it gets one.
func (t *Tracker) Created(n Network) ([]string, bool) {
	iface, ok := RelayInterface(n)
	if !ok {
		return nil, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.rules == nil {
		t.rules = map[string]string{}
	}
	if _, have := t.rules[n.ID]; have {
		return nil, false
	}
	t.rules[n.ID] = iface
	return RelayRule("-A", iface), true
}

// Destroyed returns the rule to delete for a removed network, if it had one.
func (t *Tracker) Destroyed(id string) ([]string, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	iface, ok := t.rules[id]
	if !ok {
		return nil, false
	}
	delete(t.rules, id)
	return RelayRule("-D", iface), true
}
