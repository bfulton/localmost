// Package proto is the guest agent's control protocol (contract §3.4): one
// JSON object per line, at most 64 KiB, each with "v":1 and an integer id.
// Every request is decoded strictly: unknown fields, missing fields and
// values outside the contract are refused before anything acts on them.
package proto

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// Version is the protocol version every message carries as "v".
const Version = 1

// MaxLine is the most bytes one line may hold, not counting its newline.
const MaxLine = 64 * 1024

// The agent's error codes (contract §3.4).
const (
	CodeProto         = "E_PROTO"
	CodeUnknownOp     = "E_UNKNOWN_OP"
	CodeConfigured    = "E_CONFIGURED"
	CodeNotConfigured = "E_NOT_CONFIGURED"
	CodeDisk          = "E_DISK"
	CodeSharePath     = "E_SHARE_PATH"
	CodeShareMount    = "E_SHARE_MOUNT"
	CodeDockerd       = "E_DOCKERD"
	CodeSelftest      = "E_SELFTEST"
	CodeBinds         = "E_BINDS"
)

// Limits on approve-binds (contract §3.4).
const (
	MaxBinds   = 64
	MaxPathLen = 4096
	ShareTag   = "work"
	NonceFile  = ".localmost-share"
	RelayAddr  = "198.18.0.1"
	RelayPort  = 3128
	VsockRelay = 3128
)

var (
	vmIDRe      = regexp.MustCompile(`^(?:0|[1-9][0-9]?)-[0-9a-f]{12}$`)
	containerRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// ErrLineTooLong is returned when a line exceeds MaxLine; framing is lost
// and the connection must be closed.
var ErrLineTooLong = errors.New("line longer than 64 KiB")

// LineReader reads newline-terminated lines of at most MaxLine bytes.
type LineReader struct{ r *bufio.Reader }

// NewLineReader wraps r.
func NewLineReader(r io.Reader) *LineReader {
	return &LineReader{r: bufio.NewReaderSize(r, 4096)}
}

// Next returns the next line without its newline.
func (l *LineReader) Next() ([]byte, error) {
	var buf []byte
	for {
		chunk, err := l.r.ReadSlice('\n')
		if len(buf)+len(chunk) > MaxLine+1 {
			return nil, ErrLineTooLong
		}
		buf = append(buf, chunk...)
		if err == nil {
			return buf[:len(buf)-1], nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) && len(buf) > 0 {
			return nil, io.ErrUnexpectedEOF
		}
		return nil, err
	}
}

// Error is a refusal: a code from the contract and a message.
type Error struct {
	ID      int64
	Code    string
	Message string
	// Extra fields sent with the refusal (configure's `disk: corrupt`).
	Extra map[string]any
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func refusal(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Request is a parsed request line: its id, its op, and the raw line for
// the op's own strict decoding.
type Request struct {
	ID   int64
	Op   string
	line []byte
}

// ParseRequest checks the envelope: an object with "v":1, a non-negative
// integer id and a string op.
func ParseRequest(line []byte) (*Request, *Error) {
	var env struct {
		V  *int            `json:"v"`
		ID json.RawMessage `json:"id"`
		Op *string         `json:"op"`
	}
	if err := json.Unmarshal(line, &env); err != nil {
		return nil, refusal(CodeProto, "the request is not a JSON object")
	}
	var id int64
	idOK := len(env.ID) > 0 && json.Unmarshal(env.ID, &id) == nil && id >= 0
	fail := func(msg string) (*Request, *Error) {
		e := refusal(CodeProto, "%s", msg)
		if idOK {
			e.ID = id
		}
		return nil, e
	}
	if env.V == nil || *env.V != Version {
		return fail("the request does not carry \"v\":1")
	}
	if !idOK {
		return fail("the request has no non-negative integer id")
	}
	if env.Op == nil || *env.Op == "" {
		return fail("the request has no op")
	}
	return &Request{ID: id, Op: *env.Op, line: line}, nil
}

// decodeStrict decodes the request line into dst, refusing unknown fields.
// dst must declare v, id and op as well as the op's own fields.
func (r *Request) decodeStrict(dst any, code string) *Error {
	dec := json.NewDecoder(bytes.NewReader(r.line))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return &Error{ID: r.ID, Code: code, Message: "malformed " + r.Op + " request: " + err.Error()}
	}
	return nil
}

type envelope struct {
	V  int    `json:"v"`
	ID int64  `json:"id"`
	Op string `json:"op"`
}

// CheckEmpty refuses any field beyond the envelope (hello, status, shutdown).
func CheckEmpty(r *Request) *Error {
	var m envelope
	return r.decodeStrict(&m, CodeProto)
}

// Share is configure's share object (job mode).
type Share struct {
	Tag       string `json:"tag"`
	MountPath string `json:"mountPath"`
	NonceFile string `json:"nonceFile"`
}

// Relay is configure's relay object (job mode).
type Relay struct {
	Address   string `json:"address"`
	Port      int    `json:"port"`
	VsockPort int    `json:"vsockPort"`
}

// Configure is a checked configure request.
type Configure struct {
	VMID       string
	Mode       string
	TimeUnixMs int64
	Share      *Share
	Rosetta    bool
	Relay      *Relay
}

// ParseConfigure decodes configure strictly. The share and relay are
// required in job mode and refused in refresh mode, and each fixed value
// (the tag, the nonce file's name, the relay's addresses) must be exactly
// the contract's. A refresh VM uses slot 0, and only a refresh VM does.
// The share's mount path itself is checked by the share package.
func ParseConfigure(r *Request) (*Configure, *Error) {
	var m struct {
		envelope
		VMID       *string `json:"vmId"`
		Mode       *string `json:"mode"`
		TimeUnixMs *int64  `json:"timeUnixMs"`
		Share      *Share  `json:"share"`
		Rosetta    *bool   `json:"rosetta"`
		Relay      *Relay  `json:"relay"`
	}
	if e := r.decodeStrict(&m, CodeProto); e != nil {
		return nil, e
	}
	bad := func(format string, args ...any) (*Configure, *Error) {
		e := refusal(CodeProto, format, args...)
		e.ID = r.ID
		return nil, e
	}
	if m.VMID == nil || !vmIDRe.MatchString(*m.VMID) {
		return bad("configure needs a vmId of the form <slot>-<12 hex>")
	}
	if m.Mode == nil || (*m.Mode != "job" && *m.Mode != "refresh") {
		return bad("configure needs mode job or refresh")
	}
	if m.TimeUnixMs == nil || *m.TimeUnixMs <= 0 {
		return bad("configure needs a positive timeUnixMs")
	}
	if m.Rosetta == nil {
		return bad("configure needs rosetta")
	}
	refreshSlot := strings.HasPrefix(*m.VMID, "0-")
	if *m.Mode == "job" {
		if refreshSlot {
			return bad("a job VM never uses slot 0")
		}
		if m.Share == nil || m.Share.Tag != ShareTag || m.Share.NonceFile != NonceFile || m.Share.MountPath == "" {
			return bad("a job configure needs share {tag: work, mountPath, nonceFile: .localmost-share}")
		}
		if m.Relay == nil || m.Relay.Address != RelayAddr || m.Relay.Port != RelayPort || m.Relay.VsockPort != VsockRelay {
			return bad("a job configure needs relay {address: 198.18.0.1, port: 3128, vsockPort: 3128}")
		}
	} else {
		if !refreshSlot {
			return bad("a refresh VM uses slot 0")
		}
		if m.Share != nil || m.Relay != nil || *m.Rosetta {
			return bad("a refresh configure has no share, relay or rosetta")
		}
	}
	return &Configure{VMID: *m.VMID, Mode: *m.Mode, TimeUnixMs: *m.TimeUnixMs, Share: m.Share, Rosetta: *m.Rosetta, Relay: m.Relay}, nil
}

// Bind is one approved bind (contract §3.7 "Bind matching").
type Bind struct {
	Source      string `json:"source"`
	Destination string `json:"destination"`
	ReadOnly    bool   `json:"readOnly"`
}

type rawBind struct {
	Source      *string `json:"source"`
	Destination *string `json:"destination"`
	ReadOnly    *bool   `json:"readOnly"`
}

func goodPath(p string) bool {
	return strings.HasPrefix(p, "/") && len(p) <= MaxPathLen && !strings.ContainsRune(p, 0)
}

// ParseApproveBinds decodes approve-binds: a 64-hex container id and at
// most 64 binds, each with an absolute source and destination and readOnly.
func ParseApproveBinds(r *Request) (string, []Bind, *Error) {
	var m struct {
		envelope
		Container *string    `json:"container"`
		Binds     *[]rawBind `json:"binds"`
	}
	if e := r.decodeStrict(&m, CodeBinds); e != nil {
		return "", nil, e
	}
	bad := func(format string, args ...any) (string, []Bind, *Error) {
		e := refusal(CodeBinds, format, args...)
		e.ID = r.ID
		return "", nil, e
	}
	if m.Container == nil || !containerRe.MatchString(*m.Container) {
		return bad("approve-binds needs a 64-hex container id")
	}
	if m.Binds == nil {
		return bad("approve-binds needs binds")
	}
	if len(*m.Binds) > MaxBinds {
		return bad("approve-binds takes at most %d binds", MaxBinds)
	}
	out := make([]Bind, 0, len(*m.Binds))
	for i, b := range *m.Binds {
		if b.Source == nil || b.Destination == nil || b.ReadOnly == nil {
			return bad("bind %d needs source, destination and readOnly", i)
		}
		if !goodPath(*b.Source) || !goodPath(*b.Destination) {
			return bad("bind %d needs absolute paths of at most %d bytes", i, MaxPathLen)
		}
		out = append(out, Bind{Source: *b.Source, Destination: *b.Destination, ReadOnly: *b.ReadOnly})
	}
	return *m.Container, out, nil
}

// ParseSetTime decodes set-time: a positive unixMs.
func ParseSetTime(r *Request) (int64, *Error) {
	var m struct {
		envelope
		UnixMs *int64 `json:"unixMs"`
	}
	if e := r.decodeStrict(&m, CodeProto); e != nil {
		return 0, e
	}
	if m.UnixMs == nil || *m.UnixMs <= 0 {
		return 0, &Error{ID: r.ID, Code: CodeProto, Message: "set-time needs a positive unixMs"}
	}
	return *m.UnixMs, nil
}

// ParseBindsFor decodes the guest-local binds-for: a 64-hex container id.
func ParseBindsFor(r *Request) (string, *Error) {
	var m struct {
		envelope
		Container *string `json:"container"`
	}
	if e := r.decodeStrict(&m, CodeProto); e != nil {
		return "", e
	}
	if m.Container == nil || !containerRe.MatchString(*m.Container) {
		return "", &Error{ID: r.ID, Code: CodeProto, Message: "binds-for needs a 64-hex container id"}
	}
	return *m.Container, nil
}

// Answer is a success line with the given fields.
func Answer(id int64, fields map[string]any) []byte {
	m := map[string]any{"v": Version, "id": id, "ok": true}
	for k, v := range fields {
		m[k] = v
	}
	return line(m)
}

// Refuse is a failure line for e.
func Refuse(id int64, e *Error) []byte {
	m := map[string]any{"v": Version, "id": id, "ok": false, "code": e.Code, "message": e.Message}
	for k, v := range e.Extra {
		m[k] = v
	}
	return line(m)
}

func line(m map[string]any) []byte {
	b, err := json.Marshal(m)
	if err != nil {
		b, _ = json.Marshal(map[string]any{"v": Version, "id": m["id"], "ok": false, "code": CodeProto, "message": "unencodable answer"})
	}
	return append(b, '\n')
}
