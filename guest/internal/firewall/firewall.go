// Package firewall is the guest's firewall (contract §3.6): the rules
// applied before dockerd starts, the golden form the self-test compares
// against, and the LOCALMOST-RELAY chain kept in step with Docker's
// network events. Only the bridges of routable networks may reach the
// relay address; everything else sent to the guest's root namespace is
// rejected at once, and so is anything routed toward the outside world,
// which the guest has no way to reach.
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

// NoRouteGolden is `iptables -S LOCALMOST-NOROUTE`, captured the same way.
//
//go:embed testdata/localmost-noroute.txt
var NoRouteGolden string

// BridgeNameOption is the network option that names a bridge's interface.
const BridgeNameOption = "com.docker.network.bridge.name"

// Rules returns the iptables argument lists applied, in order, before
// dockerd starts. The last opens the relay to the default bridge.
//
// LOCALMOST-NOROUTE is for traffic bound off the guest. A job VM has no NIC,
// only a default route into the dummy lm0, so a container's connection that
// ignores the proxy settings is forwarded toward lm0 and reset here, at
// once. Without the route the kernel answers with its own ICMP, which it
// rate-limits, so a raw connect hung until its SYN timeout. dockerd keeps
// DOCKER-USER's rules and evaluates that chain first in FORWARD, ahead of
// the accept it adds for each bridge's outbound traffic; OUTPUT does the
// same for the guest's own processes.
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
		{"-N", "LOCALMOST-NOROUTE"},
		{"-A", "LOCALMOST-NOROUTE", "-o", "lm0", "-p", "tcp", "-j", "REJECT", "--reject-with", "tcp-reset"},
		{"-A", "LOCALMOST-NOROUTE", "-o", "lm0", "-j", "REJECT", "--reject-with", "icmp-net-unreachable"},
		{"-N", "DOCKER-USER"},
		{"-A", "DOCKER-USER", "-j", "LOCALMOST-NOROUTE"},
		{"-I", "OUTPUT", "1", "-j", "LOCALMOST-NOROUTE"},
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

// sameLines compares an `iptables -S` listing with its golden form, line
// for line.
func sameLines(chain, got, want string) error {
	g, w := lines(got), lines(want)
	if len(g) != len(w) {
		return fmt.Errorf("%s has %d lines, want %d", chain, len(g), len(w))
	}
	for i := range w {
		if g[i] != w[i] {
			return fmt.Errorf("%s line %d is %q, want %q", chain, i+1, g[i], w[i])
		}
	}
	return nil
}

// startsWith checks that the first rule of a chain's listing is want.
func startsWith(chain, listing, want string) error {
	for _, l := range lines(listing) {
		if strings.HasPrefix(l, "-A "+chain+" ") {
			if l != want {
				break
			}
			return nil
		}
	}
	return fmt.Errorf("%s does not start with %q", chain, want)
}

// CheckRules reads each chain's `iptables -S` listing through list, once
// dockerd is up, and checks it: LOCALMOST-INPUT and LOCALMOST-NOROUTE equal
// their golden output, INPUT and OUTPUT jump to them first, and FORWARD
// reaches LOCALMOST-NOROUTE through DOCKER-USER before any rule dockerd
// added.
func CheckRules(list func(chain string) (string, error)) error {
	get := map[string]string{}
	for _, chain := range []string{"LOCALMOST-INPUT", "INPUT", "LOCALMOST-NOROUTE", "OUTPUT", "DOCKER-USER", "FORWARD"} {
		out, err := list(chain)
		if err != nil {
			return fmt.Errorf("iptables -S %s: %w", chain, err)
		}
		get[chain] = out
	}
	if err := sameLines("LOCALMOST-INPUT", get["LOCALMOST-INPUT"], Golden); err != nil {
		return err
	}
	if err := sameLines("LOCALMOST-NOROUTE", get["LOCALMOST-NOROUTE"], NoRouteGolden); err != nil {
		return err
	}
	for _, first := range [][2]string{
		{"INPUT", "-A INPUT -j LOCALMOST-INPUT"},
		{"OUTPUT", "-A OUTPUT -j LOCALMOST-NOROUTE"},
		{"DOCKER-USER", "-A DOCKER-USER -j LOCALMOST-NOROUTE"},
		{"FORWARD", "-A FORWARD -j DOCKER-USER"},
	} {
		if err := startsWith(first[0], get[first[0]], first[1]); err != nil {
			return err
		}
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

// bridgeInterface is the interface a bridge network's bridge has: the name
// its options give, or Docker's own br-<first 12 of its id>.
func bridgeInterface(n Network) string {
	if name, set := n.Options[BridgeNameOption]; set {
		return name
	}
	if len(n.ID) >= 12 {
		return "br-" + n.ID[:12]
	}
	return ""
}

// Tracker remembers which network each relay rule belongs to.
type Tracker struct {
	mu    sync.Mutex
	rules map[string]string // network id -> interface
}

// Sync is what to run when the agent (re)subscribes to Docker's events and
// lists the networks: flush LOCALMOST-RELAY, let the default bridge back
// in, and add each routable network. It starts the tracker over from the
// list, so that a destroy missed while the stream was down leaves no rule.
func (t *Tracker) Sync(ns []Network) [][]string {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.rules = map[string]string{}
	out := [][]string{{"-F", "LOCALMOST-RELAY"}, RelayRule("-A", "docker0")}
	for _, n := range ns {
		if iface, ok := RelayInterface(n); ok {
			if _, have := t.rules[n.ID]; !have {
				t.rules[n.ID] = iface
				out = append(out, RelayRule("-A", iface))
			}
		}
	}
	return out
}

// Created returns the rules to run for a new network, in order. A rule
// another network left on the new one's interface (its destroy event was
// missed) is deleted first, whether or not the new network is routable;
// then a routable network gets its own rule.
func (t *Tracker) Created(n Network) [][]string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.rules == nil {
		t.rules = map[string]string{}
	}
	if _, have := t.rules[n.ID]; have {
		return nil
	}
	var out [][]string
	if bridge := bridgeInterface(n); bridge != "" {
		for id, iface := range t.rules {
			if iface == bridge {
				delete(t.rules, id)
				out = append(out, RelayRule("-D", iface))
			}
		}
	}
	if iface, ok := RelayInterface(n); ok {
		t.rules[n.ID] = iface
		out = append(out, RelayRule("-A", iface))
	}
	return out
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
