// Package dockerapi is the agent's small client for dockerd's API on
// /run/docker.sock: the readiness ping, the version for configure's answer,
// and the network events that keep LOCALMOST-RELAY in step (contract §3.4
// steps 5 and 6). Every answer it parses is size-capped.
package dockerapi

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"

	"github.com/bfulton/localmost/guest/internal/firewall"
)

// MaxBody caps every answer the client parses.
const MaxBody = 1 << 20

// Client talks HTTP to dockerd over Dial.
type Client struct {
	Dial func(ctx context.Context) (net.Conn, error)
}

// Unix is a client for the socket at path.
func Unix(path string) Client {
	return Client{Dial: func(ctx context.Context) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", path)
	}}
}

func (c Client) http() *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext:       func(ctx context.Context, _, _ string) (net.Conn, error) { return c.Dial(ctx) },
		DisableKeepAlives: true,
	}}
}

func (c Client) get(ctx context.Context, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return nil, err
	}
	return c.http().Do(req)
}

func (c Client) getJSON(ctx context.Context, path string, dst any) error {
	res, err := c.get(ctx, path)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, MaxBody+1))
	if err != nil {
		return err
	}
	if len(body) > MaxBody {
		return fmt.Errorf("GET %s: answer over %d bytes", path, MaxBody)
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", path, res.Status)
	}
	return json.Unmarshal(body, dst)
}

// Ping is GET /_ping.
func (c Client) Ping(ctx context.Context) error {
	res, err := c.get(ctx, "/_ping")
	if err != nil {
		return err
	}
	io.Copy(io.Discard, io.LimitReader(res.Body, 64))
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("/_ping: %s", res.Status)
	}
	return nil
}

// Version is the part of GET /version the agent reports.
type Version struct {
	Version       string `json:"Version"`
	APIVersion    string `json:"ApiVersion"`
	MinAPIVersion string `json:"MinAPIVersion"`
}

// Version is GET /version.
func (c Client) Version(ctx context.Context) (Version, error) {
	var v Version
	err := c.getJSON(ctx, "/version", &v)
	return v, err
}

// Network is GET /networks/<id>.
func (c Client) Network(ctx context.Context, id string) (firewall.Network, error) {
	var n firewall.Network
	err := c.getJSON(ctx, "/networks/"+url.PathEscape(id), &n)
	return n, err
}

// Networks is GET /networks.
func (c Client) Networks(ctx context.Context) ([]firewall.Network, error) {
	var ns []firewall.Network
	err := c.getJSON(ctx, "/networks", &ns)
	return ns, err
}

// Event is one network or container event.
type Event struct {
	Type   string
	Action string
	ID     string
}

// EventFilters are the events the agent follows: networks created and
// destroyed (LOCALMOST-RELAY) and containers destroyed (bind approvals).
const EventFilters = `{"event":["create","destroy"],"type":["container","network"]}`

// Events streams those events until ctx ends or the stream breaks. `ready`
// is called once the stream is open, so that the caller can list what
// already exists without missing anything created in between.
func (c Client) Events(ctx context.Context, ready func(), fn func(Event)) error {
	filters := url.QueryEscape(EventFilters)
	res, err := c.get(ctx, "/events?filters="+filters)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("/events: %s", res.Status)
	}
	ready()
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 64*1024), MaxBody)
	for sc.Scan() {
		var ev struct {
			Type   string `json:"Type"`
			Action string `json:"Action"`
			Actor  struct {
				ID string `json:"ID"`
			} `json:"Actor"`
		}
		if json.Unmarshal(sc.Bytes(), &ev) != nil || (ev.Type != "network" && ev.Type != "container") {
			continue
		}
		fn(Event{Type: ev.Type, Action: ev.Action, ID: ev.Actor.ID})
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return io.ErrUnexpectedEOF
}
