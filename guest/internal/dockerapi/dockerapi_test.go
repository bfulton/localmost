package dockerapi

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func serve(t *testing.T, h http.HandlerFunc) Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	addr := strings.TrimPrefix(srv.URL, "http://")
	return Client{Dial: func(ctx context.Context) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", addr)
	}}
}

func TestVersionAndNetwork(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/version":
			fmt.Fprint(w, `{"Version":"29.5.3","ApiVersion":"1.54","MinAPIVersion":"1.24","GitCommit":"x"}`)
		case "/networks/abc":
			fmt.Fprint(w, `{"Id":"abc","Driver":"bridge","Internal":true}`)
		default:
			http.NotFound(w, r)
		}
	})
	v, err := c.Version(context.Background())
	if err != nil || v.Version != "29.5.3" || v.APIVersion != "1.54" || v.MinAPIVersion != "1.24" {
		t.Fatalf("%+v %v", v, err)
	}
	n, err := c.Network(context.Background(), "abc")
	if err != nil || !n.Internal || n.Driver != "bridge" {
		t.Fatalf("%+v %v", n, err)
	}
}

func TestOversizedAnswersAreRefused(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"Version":"%s"}`, strings.Repeat("x", MaxBody))
	})
	if _, err := c.Version(context.Background()); err == nil || !strings.Contains(err.Error(), "over") {
		t.Fatalf("got %v", err)
	}
}

func TestEventsCallsReadyThenEachNetworkAndContainerEvent(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("filters") != `{"event":["create","destroy"],"type":["container","network"]}` {
			http.Error(w, "filters", 400)
			return
		}
		fmt.Fprintln(w, `{"Type":"network","Action":"create","Actor":{"ID":"n1"}}`)
		fmt.Fprintln(w, `{"Type":"container","Action":"destroy","Actor":{"ID":"c1"}}`)
		fmt.Fprintln(w, `{"Type":"image","Action":"delete","Actor":{"ID":"i1"}}`)
		fmt.Fprintln(w, `{"Type":"network","Action":"destroy","Actor":{"ID":"n1"}}`)
	})
	var got []string
	readyAt := -1
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c.Events(ctx, func() { readyAt = len(got) }, func(e Event) { got = append(got, e.Type+" "+e.Action+" "+e.ID) })
	if readyAt != 0 || strings.Join(got, ",") != "network create n1,container destroy c1,network destroy n1" {
		t.Fatalf("ready at %d, events %v", readyAt, got)
	}
}
