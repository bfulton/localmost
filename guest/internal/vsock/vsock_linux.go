//go:build linux

// Package vsock is AF_VSOCK for the guest agent (contract §3.1): listeners
// on guest ports that accept only the host (CID 2), and dials to the host.
package vsock

import (
	"fmt"
	"io"
	"sync"

	"golang.org/x/sys/unix"
)

// HostCID is the host's context id.
const HostCID = unix.VMADDR_CID_HOST

// Conn is one vsock connection, half-closable.
//
// It keeps the fd blocking and reads and writes it with raw syscalls,
// rather than wrapping it in an os.File. os.File drives the Go network
// poller, and on this kernel a *dialed* AF_VSOCK fd wrapped that way never
// delivered host→guest bytes to a reader (an accepted fd did), which broke
// the proxy relay's response direction. Blocking syscalls in the per-
// direction goroutines the splice already uses have no such asymmetry.
type Conn struct {
	fd     int
	peer   uint32
	mu     sync.Mutex
	closed bool
}

func newConn(fd int, peer uint32) (*Conn, error) {
	return &Conn{fd: fd, peer: peer}, nil
}

func (c *Conn) Read(b []byte) (int, error) {
	for {
		n, err := unix.Read(c.fd, b)
		if err == unix.EINTR {
			continue
		}
		if n == 0 && len(b) > 0 && err == nil {
			return 0, io.EOF
		}
		return n, err
	}
}

func (c *Conn) Write(b []byte) (int, error) {
	total := 0
	for total < len(b) {
		n, err := unix.Write(c.fd, b[total:])
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return total, err
		}
		if n == 0 {
			return total, io.ErrShortWrite
		}
		total += n
	}
	return total, nil
}

// Close closes the connection, once.
func (c *Conn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	return unix.Close(c.fd)
}

// CloseWrite half-closes the connection so the peer reads EOF.
func (c *Conn) CloseWrite() error { return unix.Shutdown(c.fd, unix.SHUT_WR) }

// Peer is the connection's remote CID.
func (c *Conn) Peer() uint32 { return c.peer }

// Listener accepts vsock connections on one port.
type Listener struct {
	fd   int
	port uint32
}

// Listen binds a guest port for connections from any CID; Accept then
// drops every peer but the host.
func Listen(port uint32) (*Listener, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("vsock socket: %w", err)
	}
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("vsock bind %d: %w", port, err)
	}
	if err := unix.Listen(fd, 64); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("vsock listen %d: %w", port, err)
	}
	return &Listener{fd: fd, port: port}, nil
}

// Accept returns the next connection from the host (CID 2). A connection
// from any other peer is closed at once.
func (l *Listener) Accept() (*Conn, error) {
	for {
		nfd, sa, err := unix.Accept4(l.fd, unix.SOCK_CLOEXEC)
		if err != nil {
			if err == unix.EINTR || err == unix.ECONNABORTED {
				continue
			}
			return nil, err
		}
		vm, ok := sa.(*unix.SockaddrVM)
		if !ok || vm.CID != HostCID {
			unix.Close(nfd)
			continue
		}
		return newConn(nfd, vm.CID)
	}
}

// Dial connects to the host's port.
func Dial(port uint32) (*Conn, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	if err := unix.Connect(fd, &unix.SockaddrVM{CID: HostCID, Port: port}); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return newConn(fd, HostCID)
}
