# Filtering VM Network Stack

Give containers in a job's Docker VM network access beyond HTTP(S) proxying,
without giving up the job's hostname policy.

> **Status:** roadmap backlog, design notes only. It was deferred by owner
> decision 4 of the [VM Docker backend](vm-docker-backend.md). The backend
> ships with no NIC in the VM. Containers reach the network only through a
> relay to the job's own `ProxyServer`.

## Why it is deferred

The relay-only model fails closed and needs no new enforcement code. Anything
that honours `HTTP_PROXY`/`HTTPS_PROXY` works under the job's existing policy.
Everything else has no route: `git` over ssh, database drivers talking to
external hosts, gRPC clients that ignore proxies, and UDP. That is a
compatibility cost, not a security gap, so the right order is to ship the
fail-closed model and learn which workflows need more.

The alternatives available today are worse:

- **VZ NAT** gives unfiltered egress: the internet, direct DNS, the physical
  LAN (a router's admin page answered), AirPlay and other services bound to
  `0.0.0.0` on the Mac (R6).
- **Stock gvproxy** (the gvisor-tap-vsock daemon) maps `192.168.127.254` to the
  Mac's `127.0.0.1`. That reaches the broker proxy and other jobs' proxies. It
  also dials anything (R26).

## What it must do

A userspace TCP/IP stack in the helper (the gvisor-tap-vsock approach,
embedded as a library, not the stock daemon), attached to the VM as a
`VZFileHandleNetworkDeviceAttachment`, and enforcing the same policy as the
job's proxy:

- **Hostname policy, not IP policy.** `network.allow` names hosts. An IP
  filter cannot enforce that, because CDN addresses are shared by thousands of
  unrelated names. The stack must learn the host from the connection itself:
  - **TLS:** peek at the ClientHello and read the SNI. Refuse a connection
    with no SNI, or whose SNI is not allowed.
  - **HTTP:** read the `Host` header of the first request.
  - **Anything else** (ssh, database protocols): allowed only for a
    `host:port` the policy names explicitly. The address is then the one the
    stack itself resolved for that name, never the one the guest asked for.
- **Resolve on the host.** The guest's DNS is answered by the stack. It
  resolves only allowed names, pins the answer for the connection, and screens
  each resolved address with `isBlockedAddress`: no loopback, link-local,
  private or LAN addresses unless the policy's `loopback` says so.
- **No host loopback map.** No gateway address forwards to the Mac's
  `127.0.0.1`. The job's loopback policy is applied, as `ProxyServer` applies
  it, to explicitly named ports only.
- **UDP.** DNS goes to the stack's own resolver only. UDP 443 (QUIC) is
  refused, so clients fall back to TCP, where SNI is visible. Other UDP is
  refused unless a later design allows named `host:port` pairs.
- **One job's policy only.** The stack runs inside that VM's helper, under its
  seatbelt profile, and gets that job's policy at start. It is never shared
  between VMs.
- **No Local Network prompt.** The stack dials out from the helper. The
  helper's profile must allow exactly that, and the stack must never dial a LAN
  address itself, which would raise TN3179's Local Network privacy prompt.
- **Same audit trail.** Each allowed and refused connection is logged like
  a `ProxyServer` decision, with the policy line that would allow a refusal,
  so `--updaterc` discovery keeps working.

## Open questions

- Whether SNI/Host peeking is enough when Encrypted Client Hello becomes common.
  An ECH connection would have to be refused, or sent through the proxy.
- Whether to keep the relay and inject proxy settings even when the stack
  exists. That would give two paths with one policy.
- Performance of a Go (gvisor netstack) or Swift userspace stack at build
  traffic rates, compared with the relay's plain byte copy.
