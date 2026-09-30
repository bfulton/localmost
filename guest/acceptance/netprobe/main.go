// Command netprobe is the WP-A acceptance harness's network probe
// (scripts/guest/acceptance.js). The harness builds it into a test image
// and runs it in containers in the guest, to try what a job's container
// could try against the guest's firewall. It is never part of the guest
// image.
//
//	netprobe connect [-dev IFACE] IP PORT   one TCP connect; prints "connected" or the errno name
//	netprobe rawsyn -dev IFACE IP PORT      one raw SYN; prints "rst", "synack" or "none"
//	netprobe vsock CID PORT                 one AF_VSOCK connect; prints "connected" or the errno name
//	netprobe listen PORT                    listens on 0.0.0.0; prints "accepted <peer>" for each connection
//
// -dev binds the socket to an interface (SO_BINDTODEVICE, which Docker's
// default CAP_NET_RAW allows). With an interface and no route, Linux takes
// the destination as on the link and asks for its MAC, which the guest's
// bridge answers for every address the guest has: this is how a container
// on an internal network addresses the relay without a route.
package main

import (
	"fmt"
	"os"
)

func main() {
	out, err := run(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "netprobe: %v\n", err)
		os.Exit(2)
	}
	fmt.Println(out)
}
