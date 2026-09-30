package relay

import (
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// upstream answers each connection with "got:" and everything it read, once
// the client half-closed, which checks that half-close crosses the relay.
func upstream(t *testing.T) net.Listener {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				b, _ := io.ReadAll(c)
				c.Write(append([]byte("got:"), b...))
			}()
		}
	}()
	t.Cleanup(func() { l.Close() })
	return l
}

func startRelay(t *testing.T, r *Relay) net.Listener {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go r.Serve(l)
	t.Cleanup(func() { l.Close() })
	return l
}

func TestRelayCopiesBothWaysWithHalfClose(t *testing.T) {
	up := upstream(t)
	r := New(func() (Conn, error) {
		c, err := net.Dial("tcp", up.Addr().String())
		if err != nil {
			return nil, err
		}
		return c.(*net.TCPConn), nil
	}, 4)
	l := startRelay(t, r)
	c, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte("hello"))
	c.(*net.TCPConn).CloseWrite()
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	b, _ := io.ReadAll(c)
	if string(b) != "got:hello" {
		t.Fatalf("got %q", b)
	}
}

func TestRelayClosesAtOnceWhenTheDialFails(t *testing.T) {
	r := New(func() (Conn, error) { return nil, io.ErrClosedPipe }, 4)
	l := startRelay(t, r)
	c, _ := net.Dial("tcp", l.Addr().String())
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	if n, err := c.Read(make([]byte, 1)); n != 0 || err == nil || strings.Contains(err.Error(), "timeout") {
		t.Fatalf("read %d, %v; want EOF or reset", n, err)
	}
}

func TestIgnoredSourcesAreClosedWithoutDialling(t *testing.T) {
	dialled := make(chan struct{}, 1)
	r := New(func() (Conn, error) { dialled <- struct{}{}; return nil, io.ErrClosedPipe }, 4)
	undo := r.Ignore("127.0.0.1")
	l := startRelay(t, r)
	c, _ := net.Dial("tcp", l.Addr().String())
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	c.Read(make([]byte, 1))
	c.Close()
	select {
	case <-dialled:
		t.Fatal("an ignored source was dialled")
	case <-time.After(100 * time.Millisecond):
	}
	undo()
	c2, _ := net.Dial("tcp", l.Addr().String())
	defer c2.Close()
	select {
	case <-dialled:
	case <-time.After(10 * time.Second):
		t.Fatal("after undo the source was not dialled")
	}
}

func TestRelayLimitsConcurrentConnections(t *testing.T) {
	block := make(chan struct{})
	up := upstream(t)
	r := New(func() (Conn, error) {
		<-block
		c, err := net.Dial("tcp", up.Addr().String())
		if err != nil {
			return nil, err
		}
		return c.(*net.TCPConn), nil
	}, 1)
	l := startRelay(t, r)
	first, _ := net.Dial("tcp", l.Addr().String())
	defer first.Close()
	time.Sleep(50 * time.Millisecond)
	second, _ := net.Dial("tcp", l.Addr().String())
	defer second.Close()
	second.SetReadDeadline(time.Now().Add(10 * time.Second))
	if _, err := second.Read(make([]byte, 1)); err == nil {
		t.Fatal("a connection past the limit was served")
	}
	close(block)
}
