package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// The hook every container create, run and restore gets (contract §3.7).
const hookPath = "/usr/libexec/localmost/lm-bindpin"

var hook = map[string]any{"path": hookPath, "args": []string{"lm-bindpin"}, "timeout": 10}

// runc's global flags that take a value, and those that do not. Anything
// else before the subcommand is refused: an unknown flag could hide where
// the subcommand is, and a create that is not seen would skip the hook.
var (
	valueFlags = map[string]bool{"--root": true, "--log": true, "--log-format": true, "--criu": true, "--rootless": true}
	boolFlags  = map[string]bool{"--debug": true, "--systemd-cgroup": true, "--help": true, "-h": true, "--version": true, "-v": true}
)

// parseArgs finds runc's subcommand and, for it, the --bundle/-b value
// ("" means the current directory).
func parseArgs(args []string) (sub, bundle string, err error) {
	i := 1
	for ; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			break
		}
		name := a
		if eq := strings.IndexByte(a, '='); eq > 0 {
			name = a[:eq]
		}
		switch {
		case valueFlags[name] && name == a:
			i++
		case valueFlags[name], boolFlags[name]:
		default:
			return "", "", fmt.Errorf("lm-runc: unknown global flag %q", a)
		}
	}
	if i >= len(args) {
		return "", "", nil
	}
	sub = args[i]
	for j := i + 1; j < len(args); j++ {
		a := args[j]
		switch {
		case a == "--bundle" || a == "-b":
			if j+1 < len(args) {
				bundle = args[j+1]
			}
			j++
		case strings.HasPrefix(a, "--bundle="):
			bundle = strings.TrimPrefix(a, "--bundle=")
		case strings.HasPrefix(a, "-b="):
			bundle = strings.TrimPrefix(a, "-b=")
		}
	}
	return sub, bundle, nil
}

func needsHook(sub string) bool { return sub == "create" || sub == "run" || sub == "restore" }

// maxConfig bounds how much of config.json is read.
const maxConfig = 16 << 20

// addHook appends the lm-bindpin hook to hooks.createRuntime in
// <bundle>/config.json, keeping every other field and hook, and writes the
// file back through a temporary file and a rename. A hook already there is
// not added twice.
func addHook(bundle string) error {
	p := filepath.Join(bundle, "config.json")
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(f, maxConfig+1))
	f.Close()
	if err != nil {
		return err
	}
	if len(data) > maxConfig {
		return errors.New("lm-runc: config.json is too large")
	}
	var cfg map[string]json.RawMessage
	if err := json.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("lm-runc: config.json: %w", err)
	}
	hooks := map[string]json.RawMessage{}
	if raw, ok := cfg["hooks"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &hooks); err != nil {
			return fmt.Errorf("lm-runc: config.json hooks: %w", err)
		}
	}
	var create []json.RawMessage
	if raw, ok := hooks["createRuntime"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &create); err != nil {
			return fmt.Errorf("lm-runc: config.json createRuntime: %w", err)
		}
	}
	for _, h := range create {
		var x struct {
			Path string `json:"path"`
		}
		if json.Unmarshal(h, &x) == nil && x.Path == hookPath {
			return nil
		}
	}
	ours, _ := json.Marshal(hook)
	create = append(create, ours)
	if hooks["createRuntime"], err = json.Marshal(create); err != nil {
		return err
	}
	if cfg["hooks"], err = json.Marshal(hooks); err != nil {
		return err
	}
	out, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(bundle, ".config.json.lm-runc-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, bytes.NewReader(out)); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}
