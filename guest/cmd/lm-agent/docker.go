package main

import "github.com/bfulton/localmost/guest/internal/relay"

// serveDocker splices one host connection on vsock 2375 to dockerd. Until
// the agent is ready (configure ran every step and the self-test passed)
// the connection is closed at once: a daemon behind a firewall that failed
// its self-test, or that configure gave up on, never answers the host. It
// is closed too when dockerd cannot be dialled.
func serveDocker(ready func() bool, c relay.Conn, dial func() (relay.Conn, error)) {
	if !ready() {
		c.Close()
		return
	}
	d, err := dial()
	if err != nil {
		c.Close()
		return
	}
	relay.Splice(c, d)
}

// rootPeer is the local socket's check on its peer's credentials: only
// root (lm-bindpin, run by runc) may ask for approvals, and a peer whose
// credentials cannot be read is refused.
func rootPeer(uid uint32, err error) bool { return err == nil && uid == 0 }
