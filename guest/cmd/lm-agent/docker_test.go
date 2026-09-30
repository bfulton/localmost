package main

import (
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/bfulton/localmost/guest/internal/relay"
)

// pair returns the two ends of a loopback TCP connection.
func pair(t *testing.T) (*net.TCPConn, *net.TCPConn) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, _ := l.Accept()
		accepted <- c
	}()
	a, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	b := <-accepted
	t.Cleanup(func() { a.Close(); b.Close() })
	return a.(*net.TCPConn), b.(*net.TCPConn)
}

func TestTheDockerAPIIsClosedUntilTheAgentIsReady(t *testing.T) {
	host, agentSide := pair(t)
	dialled := false
	go serveDocker(func() bool { return false }, agentSide, func() (relay.Conn, error) {
		dialled = true
		return nil, errors.New("unreachable")
	})
	host.SetReadDeadline(time.Now().Add(10 * time.Second))
	if n, err := host.Read(make([]byte, 1)); n != 0 || err == nil || strings.Contains(err.Error(), "timeout") {
		t.Fatalf("read %d, %v; want the connection closed", n, err)
	}
	if dialled {
		t.Fatal("dockerd was dialled before the agent was ready")
	}
}

func TestTheDockerAPIIsSplicedOnceReady(t *testing.T) {
	host, agentSide := pair(t)
	daemonAgent, daemon := pair(t)
	go serveDocker(func() bool { return true }, agentSide, func() (relay.Conn, error) { return daemonAgent, nil })
	go func() {
		b, _ := io.ReadAll(daemon)
		daemon.Write(append([]byte("pong:"), b...))
		daemon.Close()
	}()
	host.Write([]byte("ping"))
	host.CloseWrite()
	host.SetReadDeadline(time.Now().Add(10 * time.Second))
	if b, _ := io.ReadAll(host); string(b) != "pong:ping" {
		t.Fatalf("got %q", b)
	}
}

func TestOnlyRootMayUseTheLocalSocket(t *testing.T) {
	if !rootPeer(0, nil) {
		t.Fatal("root was refused")
	}
	if rootPeer(1000, nil) {
		t.Fatal("uid 1000 was accepted")
	}
	if rootPeer(0, errors.New("no SO_PEERCRED")) {
		t.Fatal("an unknown peer was accepted")
	}
}
