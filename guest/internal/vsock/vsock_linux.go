//go:build linux

// Package vsock is AF_VSOCK for the guest agent (contract §3.1): listeners
// on guest ports that accept only the host (CID 2), and dials to the host.
package vsock

import (
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// Conn is one vsock connection, pollable and half-closable.
type Conn struct {
	f    *os.File
	fd   int
	peer uint32
}

func newConn(fd int, peer uint32) (*Conn, error) {
	if err := unix.SetNonblock(fd, true); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return &Conn{f: os.NewFile(uintptr(fd), "vsock"), fd: fd, peer: peer}, nil
}

func (c *Conn) Read(b []byte) (int, error)  { return c.f.Read(b) }
func (c *Conn) Write(b []byte) (int, error) { return c.f.Write(b) }
func (c *Conn) Close() error                { return c.f.Close() }

// CloseWrite half-closes the connection.
func (c *Conn) CloseWrite() error { return unix.Shutdown(c.fd, unix.SHUT_WR) }

// SetDeadline sets read and write deadlines.
func (c *Conn) SetDeadline(t time.Time) error { return c.f.SetDeadline(t) }

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
		if !ok || !FromHost(vm.CID) {
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
