package vsock

import "testing"

func TestOnlyTheHostIsAccepted(t *testing.T) {
	// 0 is the hypervisor, 1 local loopback, 2 the host, 3 and up guests.
	for cid, want := range map[uint32]bool{0: false, 1: false, 2: true, 3: false, 0xffffffff: false} {
		if FromHost(cid) != want {
			t.Errorf("cid %d: got %v", cid, !want)
		}
	}
}
