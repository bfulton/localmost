package proto

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestLineReaderCapsLinesAt64KiB(t *testing.T) {
	exact := strings.Repeat("a", MaxLine)
	r := NewLineReader(strings.NewReader(exact + "\n" + strings.Repeat("b", MaxLine+1) + "\n"))
	line, err := r.Next()
	if err != nil || len(line) != MaxLine {
		t.Fatalf("a line of exactly 64 KiB: len %d, err %v", len(line), err)
	}
	if _, err := r.Next(); !errors.Is(err, ErrLineTooLong) {
		t.Fatalf("a line one byte over: err %v, want ErrLineTooLong", err)
	}
}

func TestLineReaderSplitsLines(t *testing.T) {
	r := NewLineReader(strings.NewReader("{\"a\":1}\n{\"b\":2}\n"))
	for _, want := range []string{`{"a":1}`, `{"b":2}`} {
		got, err := r.Next()
		if err != nil || string(got) != want {
			t.Fatalf("got %q, %v; want %q", got, err, want)
		}
	}
}

func TestParseRequestNeedsVersionIDAndOp(t *testing.T) {
	cases := map[string]string{
		`not json`:                      CodeProto,
		`{"v":2,"id":1,"op":"hello"}`:   CodeProto,
		`{"id":1,"op":"hello"}`:         CodeProto,
		`{"v":1,"op":"hello"}`:          CodeProto,
		`{"v":1,"id":-1,"op":"hello"}`:  CodeProto,
		`{"v":1,"id":1.5,"op":"hello"}`: CodeProto,
		`{"v":1,"id":1}`:                CodeProto,
		`[1,2]`:                         CodeProto,
	}
	for line, code := range cases {
		if _, perr := ParseRequest([]byte(line)); perr == nil || perr.Code != code {
			t.Errorf("%s: got %v, want %s", line, perr, code)
		}
	}
	req, perr := ParseRequest([]byte(`{"v":1,"id":7,"op":"hello"}`))
	if perr != nil || req.ID != 7 || req.Op != "hello" {
		t.Fatalf("valid hello: %+v %v", req, perr)
	}
}

func TestIDOfAMalformedRequestIsKeptWhenReadable(t *testing.T) {
	_, perr := ParseRequest([]byte(`{"v":2,"id":9,"op":"hello"}`))
	if perr == nil || perr.ID != 9 {
		t.Fatalf("got %+v, want the refusal to carry id 9", perr)
	}
}

func mustReq(t *testing.T, line string) *Request {
	t.Helper()
	req, perr := ParseRequest([]byte(line))
	if perr != nil {
		t.Fatalf("%s: %v", line, perr)
	}
	return req
}

func TestConfigureJobRequest(t *testing.T) {
	req := mustReq(t, `{"v":1,"id":1,"op":"configure","vmId":"3-0123456789ab","mode":"job","timeUnixMs":1790000000000,`+
		`"share":{"tag":"work","mountPath":"/Users/me/.localmost/runner/sandbox/3-aaaaaaaaaaaa/_work","nonceFile":".localmost-share"},`+
		`"rosetta":true,"relay":{"address":"198.18.0.1","port":3128,"vsockPort":3128}}`)
	c, perr := ParseConfigure(req)
	if perr != nil {
		t.Fatal(perr)
	}
	if c.Mode != "job" || c.Share == nil || c.Share.MountPath == "" || !c.Rosetta || c.TimeUnixMs != 1790000000000 {
		t.Fatalf("parsed %+v", c)
	}
}

func TestConfigureRefusals(t *testing.T) {
	base := func(over map[string]any) string {
		m := map[string]any{
			"v": 1, "id": 1, "op": "configure", "vmId": "3-0123456789ab", "mode": "job", "timeUnixMs": 1,
			"share":   map[string]any{"tag": "work", "mountPath": "/Users/x/_work", "nonceFile": ".localmost-share"},
			"rosetta": false,
			"relay":   map[string]any{"address": "198.18.0.1", "port": 3128, "vsockPort": 3128},
		}
		for k, v := range over {
			if v == nil {
				delete(m, k)
			} else {
				m[k] = v
			}
		}
		b, _ := json.Marshal(m)
		return string(b)
	}
	cases := map[string]string{
		"unknown field":         base(map[string]any{"extra": 1}),
		"bad vmId":              base(map[string]any{"vmId": "03-0123456789ab"}),
		"bad mode":              base(map[string]any{"mode": "other"}),
		"job without share":     base(map[string]any{"share": nil}),
		"job without relay":     base(map[string]any{"relay": nil}),
		"other share tag":       base(map[string]any{"share": map[string]any{"tag": "rosetta", "mountPath": "/x/y", "nonceFile": ".localmost-share"}}),
		"other nonce file":      base(map[string]any{"share": map[string]any{"tag": "work", "mountPath": "/x/y", "nonceFile": "../x"}}),
		"other relay address":   base(map[string]any{"relay": map[string]any{"address": "10.0.0.1", "port": 3128, "vsockPort": 3128}}),
		"missing rosetta":       base(map[string]any{"rosetta": nil}),
		"missing time":          base(map[string]any{"timeUnixMs": nil}),
		"refresh with share":    base(map[string]any{"mode": "refresh", "vmId": "0-0123456789ab", "relay": nil}),
		"refresh on a job slot": base(map[string]any{"mode": "refresh", "share": nil, "relay": nil}),
		"job on slot 0":         base(map[string]any{"vmId": "0-0123456789ab"}),
	}
	for name, line := range cases {
		if _, perr := ParseConfigure(mustReq(t, line)); perr == nil || perr.Code != CodeProto {
			t.Errorf("%s: got %v, want E_PROTO", name, perr)
		}
	}
	refresh := base(map[string]any{"mode": "refresh", "vmId": "0-0123456789ab", "share": nil, "relay": nil})
	if _, perr := ParseConfigure(mustReq(t, refresh)); perr != nil {
		t.Errorf("a refresh configure: %v", perr)
	}
}

func approve(container string, binds []map[string]any) string {
	b, _ := json.Marshal(map[string]any{"v": 1, "id": 4, "op": "approve-binds", "container": container, "binds": binds})
	return string(b)
}

var cid = strings.Repeat("a1", 32)

func TestApproveBindsLimits(t *testing.T) {
	ok := []map[string]any{{"source": "/Users/x/_work/a", "destination": "/a", "readOnly": true}}
	if _, _, perr := ParseApproveBinds(mustReq(t, approve(cid, ok))); perr != nil {
		t.Fatalf("one bind: %v", perr)
	}
	many := make([]map[string]any, 65)
	for i := range many {
		many[i] = map[string]any{"source": "/s", "destination": "/d", "readOnly": false}
	}
	cases := map[string]string{
		"short container":      approve("abc", ok),
		"uppercase container":  approve(strings.ToUpper(cid), ok),
		"65 binds":             approve(cid, many),
		"relative source":      approve(cid, []map[string]any{{"source": "rel", "destination": "/a", "readOnly": true}}),
		"relative destination": approve(cid, []map[string]any{{"source": "/s", "destination": "a", "readOnly": true}}),
		"NUL in source":        approve(cid, []map[string]any{{"source": "/s\x00x", "destination": "/a", "readOnly": true}}),
		"missing readOnly":     approve(cid, []map[string]any{{"source": "/s", "destination": "/a"}}),
		"extra field":          approve(cid, []map[string]any{{"source": "/s", "destination": "/a", "readOnly": true, "x": 1}}),
		"long source":          approve(cid, []map[string]any{{"source": "/" + strings.Repeat("s", 4096), "destination": "/a", "readOnly": true}}),
	}
	for name, line := range cases {
		if _, _, perr := ParseApproveBinds(mustReq(t, line)); perr == nil || perr.Code != CodeBinds {
			t.Errorf("%s: got %v, want E_BINDS", name, perr)
		}
	}
	if _, binds, perr := ParseApproveBinds(mustReq(t, approve(cid, many[:64]))); perr != nil || len(binds) != 64 {
		t.Errorf("64 binds: %d, %v", len(binds), perr)
	}
	if _, binds, perr := ParseApproveBinds(mustReq(t, approve(cid, []map[string]any{}))); perr != nil || len(binds) != 0 {
		t.Errorf("no binds: %v", perr)
	}
}

func TestAnswersAreOneLineWithVersionAndID(t *testing.T) {
	ok := Answer(3, map[string]any{"agent": "0.1.0"})
	refuse := Refuse(4, &Error{Code: CodeUnknownOp, Message: "no op x"})
	for _, b := range [][]byte{ok, refuse} {
		if bytes.Count(b, []byte("\n")) != 1 || !bytes.HasSuffix(b, []byte("\n")) {
			t.Fatalf("not one line: %q", b)
		}
	}
	var m map[string]any
	if err := json.Unmarshal(refuse, &m); err != nil {
		t.Fatal(err)
	}
	if m["v"] != float64(1) || m["id"] != float64(4) || m["ok"] != false || m["code"] != CodeUnknownOp {
		t.Fatalf("refusal %v", m)
	}
	if err := json.Unmarshal(ok, &m); err != nil || m["ok"] != true || m["agent"] != "0.1.0" {
		t.Fatalf("answer %v", m)
	}
}
