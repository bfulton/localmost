package relay

import (
	"net"
	"strings"
	"testing"
	"time"
)

func TestRelayClosesConnectionsPastItsCap(t *testing.T) {
	// The upstream holds every connection open, so each keeps its slot.
	hold := make(chan struct{})
	up, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { close(hold); up.Close() })
	go func() {
		for {
			c, err := up.Accept()
			if err != nil {
				return
			}
			go func() { <-hold; c.Close() }()
		}
	}()
	dials := make(chan struct{}, 8)
	r := New(func() (Conn, error) {
		c, err := net.Dial("tcp", up.Addr().String())
		if err != nil {
			return nil, err
		}
		dials <- struct{}{}
		return c.(*net.TCPConn), nil
	}, 2)
	l := startRelay(t, r)
	for i := 0; i < 2; i++ {
		c, err := net.Dial("tcp", l.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		select {
		case <-dials:
		case <-time.After(10 * time.Second):
			t.Fatalf("connection %d was not relayed", i+1)
		}
	}
	third, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close()
	third.SetReadDeadline(time.Now().Add(10 * time.Second))
	if n, err := third.Read(make([]byte, 1)); n != 0 || err == nil || strings.Contains(err.Error(), "timeout") {
		t.Fatalf("the third connection read %d, %v; want it closed at once", n, err)
	}
	if len(dials) != 0 {
		t.Fatal("the third connection was dialled")
	}
}
