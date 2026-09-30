package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSubcommandAndBundle(t *testing.T) {
	cases := []struct {
		args   []string
		sub    string
		bundle string
	}{
		{[]string{"runc", "--root", "/run/containerd/runc/moby", "--log", "/x/log.json", "--log-format", "json", "create", "--bundle", "/b", "--pid-file", "/p", "id"}, "create", "/b"},
		{[]string{"runc", "--systemd-cgroup", "--debug", "run", "-b", "/b2", "id"}, "run", "/b2"},
		{[]string{"runc", "--root=/r", "restore", "--bundle=/b3", "id"}, "restore", "/b3"},
		{[]string{"runc", "create", "id"}, "create", ""},
		{[]string{"runc", "--root", "/r", "start", "id"}, "start", ""},
		{[]string{"runc", "--root", "/r", "delete", "--force", "id"}, "delete", ""},
		{[]string{"runc", "--version"}, "", ""},
	}
	for _, c := range cases {
		sub, bundle, err := parseArgs(c.args)
		if err != nil || sub != c.sub || bundle != c.bundle {
			t.Errorf("%v: got %q %q %v", c.args, sub, bundle, err)
		}
	}
}

func TestAnUnknownGlobalFlagFailsClosed(t *testing.T) {
	if _, _, err := parseArgs([]string{"runc", "--new-flag", "x", "create", "id"}); err == nil {
		t.Fatal("an unknown global flag was accepted")
	}
}

func TestNeedsHook(t *testing.T) {
	for sub, want := range map[string]bool{"create": true, "run": true, "restore": true, "start": false, "delete": false, "state": false, "exec": false, "": false} {
		if needsHook(sub) != want {
			t.Errorf("%s: %v", sub, !want)
		}
	}
}

func writeConfig(t *testing.T, dir string, v any) string {
	t.Helper()
	b, _ := json.Marshal(v)
	p := filepath.Join(dir, "config.json")
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func readConfig(t *testing.T, p string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

var ourHook = map[string]any{"path": "/usr/libexec/localmost/lm-bindpin", "args": []any{"lm-bindpin"}, "timeout": float64(10)}

func TestAddHookAppendsToCreateRuntimeAndKeepsEverythingElse(t *testing.T) {
	dir := t.TempDir()
	existing := map[string]any{"path": "/usr/bin/other", "args": []any{"other"}}
	p := writeConfig(t, dir, map[string]any{
		"ociVersion": "1.2.0",
		"process":    map[string]any{"args": []any{"sh"}, "unknownField": true},
		"hooks": map[string]any{
			"createRuntime": []any{existing},
			"poststart":     []any{map[string]any{"path": "/x"}},
		},
		"futureField": []any{1, 2},
	})
	if err := addHook(dir); err != nil {
		t.Fatal(err)
	}
	m := readConfig(t, p)
	hooks := m["hooks"].(map[string]any)
	cr := hooks["createRuntime"].([]any)
	if len(cr) != 2 || !reflect.DeepEqual(cr[0], existing) || !reflect.DeepEqual(cr[1], ourHook) {
		t.Fatalf("createRuntime %v", cr)
	}
	if hooks["poststart"] == nil || m["futureField"] == nil || m["process"].(map[string]any)["unknownField"] != true {
		t.Fatalf("fields lost: %v", m)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("temporary file left behind: %v", entries)
	}
}

func TestAddHookWithNoHooksAndOnlyOnce(t *testing.T) {
	dir := t.TempDir()
	p := writeConfig(t, dir, map[string]any{"ociVersion": "1.2.0"})
	if err := addHook(dir); err != nil {
		t.Fatal(err)
	}
	if err := addHook(dir); err != nil {
		t.Fatal(err)
	}
	cr := readConfig(t, p)["hooks"].(map[string]any)["createRuntime"].([]any)
	if len(cr) != 1 || !reflect.DeepEqual(cr[0], ourHook) {
		t.Fatalf("createRuntime %v", cr)
	}
}

func TestAddHookFailsOnAMissingOrBrokenConfig(t *testing.T) {
	if err := addHook(t.TempDir()); err == nil {
		t.Fatal("no config.json was accepted")
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "config.json"), []byte("{"), 0o600)
	if err := addHook(dir); err == nil {
		t.Fatal("a broken config.json was accepted")
	}
}
