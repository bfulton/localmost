package kmod

import (
	"reflect"
	"testing"
)

func TestResolveAliasesAndNames(t *testing.T) {
	aliases := ParseAliases("alias fs-ext4 ext4\nalias net-pf-17 af_packet\nalias nft-chain-2-* nft_chain_nat\n# comment\n")
	cases := map[string][]string{
		"fs-ext4":         {"ext4"},
		"net-pf-17":       {"af_packet"},
		"nft-chain-2-nat": {"nft_chain_nat"},
		"br-netfilter":    {"br_netfilter"},
		"xt_nat":          {"xt_nat"},
	}
	for req, want := range cases {
		if got := Resolve(req, aliases); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %v", req, got)
		}
	}
}

func TestNameOfAndBuiltin(t *testing.T) {
	if NameOf("kernel/drivers/char/hw_random/virtio-rng.ko") != "virtio_rng" {
		t.Fatal(NameOf("kernel/drivers/char/hw_random/virtio-rng.ko"))
	}
	b := ParseBuiltin("kernel/fs/proc/proc.ko\nkernel/net/unix/unix.ko\n")
	if !b["proc"] || !b["unix"] || b["ext4"] {
		t.Fatalf("%v", b)
	}
}

func TestRequestedNames(t *testing.T) {
	cases := []struct {
		args   []string
		names  []string
		remove bool
	}{
		{[]string{"/sbin/modprobe", "-q", "--", "net-pf-17"}, []string{"net-pf-17"}, false},
		{[]string{"modprobe", "-va", "bridge", "br_netfilter"}, []string{"bridge", "br_netfilter"}, false},
		{[]string{"modprobe", "ip_vs", "conn_tab_bits=12"}, []string{"ip_vs"}, false},
		{[]string{"modprobe", "-r", "x"}, []string{"x"}, true},
		{[]string{"modprobe"}, nil, false},
	}
	for _, c := range cases {
		names, remove := RequestedNames(c.args)
		if !reflect.DeepEqual(names, c.names) || remove != c.remove {
			t.Errorf("%v: %v %v", c.args, names, remove)
		}
	}
}
