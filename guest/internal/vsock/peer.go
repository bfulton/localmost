package vsock

// HostCID is the host's context id (VMADDR_CID_HOST).
const HostCID = 2

// FromHost reports whether a connection's peer is the host. The agent's
// listeners take connections from no other peer: not the hypervisor (0),
// not a local loopback (1), and not another guest.
func FromHost(cid uint32) bool { return cid == HostCID }
