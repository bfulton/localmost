// Package relay copies bytes between connections without parsing them: the
// proxy relay from 198.18.0.1:3128 to vsock port 3128 on the host (contract
// §3.4 step 5), and the Docker API splice from vsock 2375 to
// /run/docker.sock.
package relay

import (
	"io"
	"net"
	"sync"
)

// Conn is a connection that can be half-closed.
type Conn interface {
	io.ReadWriteCloser
	CloseWrite() error
}

// Splice copies both ways until each side has reached EOF, half-closing
// the other side as each direction ends, then closes both.
func Splice(a, b Conn) {
	var wg sync.WaitGroup
	pump := func(dst, src Conn) {
		defer wg.Done()
		buf := make([]byte, 64*1024)
		io.CopyBuffer(dst, src, buf)
		dst.CloseWrite()
	}
	wg.Add(2)
	go pump(a, b)
	go pump(b, a)
	wg.Wait()
	a.Close()
	b.Close()
}

// Relay accepts connections and splices each to a new dialled connection.
type Relay struct {
	dial   func() (Conn, error)
	slots  chan struct{}
	mu     sync.Mutex
	ignore map[string]int
}

// New returns a relay that dials with dial and serves at most max
// connections at once; a connection past that is closed.
func New(dial func() (Conn, error), max int) *Relay {
	return &Relay{dial: dial, slots: make(chan struct{}, max), ignore: map[string]int{}}
}

// Ignore makes connections from ip close without dialling, until undo is
// called. The self-test uses it so that its probe never reaches the proxy.
func (r *Relay) Ignore(ip string) (undo func()) {
	r.mu.Lock()
	r.ignore[ip]++
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		if r.ignore[ip]--; r.ignore[ip] <= 0 {
			delete(r.ignore, ip)
		}
		r.mu.Unlock()
	}
}

func (r *Relay) ignored(addr net.Addr) bool {
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ignore[host] > 0
}

// Serve accepts until the listener is closed.
func (r *Relay) Serve(l net.Listener) error {
	for {
		c, err := l.Accept()
		if err != nil {
			return err
		}
		go r.handle(c)
	}
}

func (r *Relay) handle(c net.Conn) {
	if r.ignored(c.RemoteAddr()) {
		c.Close()
		return
	}
	select {
	case r.slots <- struct{}{}:
	default:
		c.Close()
		return
	}
	defer func() { <-r.slots }()
	in, ok := c.(Conn)
	if !ok {
		c.Close()
		return
	}
	out, err := r.dial()
	if err != nil {
		c.Close()
		return
	}
	Splice(in, out)
}
