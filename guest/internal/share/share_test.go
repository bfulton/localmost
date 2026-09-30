package share

import (
	"strings"
	"testing"
)

func TestValidMountPaths(t *testing.T) {
	for p, want := range map[string]string{
		"/Users/me/.localmost/runner/sandbox/3-0123456789ab/_work":          "Users",
		"/Volumes/Data/home/.localmost/runner/sandbox/1-aaaaaaaaaaaa/_work": "Volumes",
		// os.tmpdir() and /tmp resolve under /private, where the e2e
		// launcher puts LOCALMOST_CONFIG_DIR.
		"/private/var/folders/45/x/T/lm-e2e/runner/sandbox/1-aaaaaaaaaaaa/_work": "private",
	} {
		top, err := CheckMountPath(p)
		if err != nil || top != want {
			t.Errorf("%s: got %q, %v", p, top, err)
		}
	}
}

func TestMountPathRefusals(t *testing.T) {
	cases := map[string]string{
		"relative":                       "Users/me/_work",
		"dot":                            "/Users/./me/_work",
		"dot dot":                        "/Users/me/../_work",
		"double slash":                   "/Users//me/_work",
		"trailing slash":                 "/Users/me/_work/",
		"root":                           "/",
		"empty":                          "",
		"NUL":                            "/Users/me\x00/_work",
		"a top-level name the root uses": "/var/lib/_work",
		"another the root uses":          "/run/_work",
		"a name outside the allowlist":   "/opt/me/_work",
		"a case variant":                 "/users/me/_work",
		"a mount root alone":             "/Users",
		"over 1024 bytes":                "/Users/" + strings.Repeat("a", 1018),
	}
	for name, p := range cases {
		if _, err := CheckMountPath(p); err == nil {
			t.Errorf("%s: %q accepted", name, p)
		}
	}
	if _, err := CheckMountPath("/Users/" + strings.Repeat("a", 1017)); err != nil {
		t.Errorf("exactly 1024 bytes refused: %v", err)
	}
}
