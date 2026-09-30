package rosetta

import (
	"strings"
	"testing"
)

func TestRegisterMatchesTheContract(t *testing.T) {
	f := strings.Split(Register, ":")
	// "", name, type, offset, magic, mask, interpreter, flags
	if len(f) != 8 || f[1] != "rosetta" || f[2] != "M" || f[3] != "" {
		t.Fatalf("fields %q", f)
	}
	if f[4] != `\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00` {
		t.Fatalf("magic %q", f[4])
	}
	// Each \xNN is one byte; the magic and the mask are both 20 bytes.
	decoded := func(s string) int { return len(s) - 3*strings.Count(s, `\x`) }
	if decoded(f[4]) != 20 || decoded(f[5]) != 20 || !strings.HasPrefix(f[5], `\xff\xff\xff\xff\xff\xfe\xfe\x00`) {
		t.Fatalf("mask %q", f[5])
	}
	if f[6] != "/run/rosetta/rosetta" || f[7] != "CF" {
		t.Fatalf("interpreter %q flags %q", f[6], f[7])
	}
}
