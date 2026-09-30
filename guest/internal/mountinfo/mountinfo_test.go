package mountinfo

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/bfulton/localmost/guest/internal/proto"
)

const sample = `22 1 254:0 / / ro,relatime shared:1 - erofs /dev/vda ro,user_xattr
25 22 0:22 / /proc rw,nosuid,nodev,noexec,relatime shared:2 - proc proc rw
61 60 0:42 / /Users/me/.localmost/runner/sandbox/3-0123456789ab/_work rw,nosuid,nodev,nosymfollow,relatime shared:30 - virtiofs work rw
90 88 0:42 /r/r/my\040data /var/lib/docker/overlay2/abc/merged/data ro,nosuid,nodev,nosymfollow,relatime master:30 - virtiofs work rw
91 88 0:42 /tab\011and\012newline\134slash /var/lib/docker/overlay2/abc/merged/odd rw,nosuid,nodev,nosymfollow - virtiofs work rw
`

func TestParseFieldsAndMountIDs(t *testing.T) {
	ms, err := Parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 5 {
		t.Fatalf("got %d mounts", len(ms))
	}
	m := ms[3]
	if m.ID != 90 || m.Parent != 88 || m.Major != 0 || m.Minor != 42 {
		t.Fatalf("ids: %+v", m)
	}
	if m.Root != "/r/r/my data" || m.MountPoint != "/var/lib/docker/overlay2/abc/merged/data" {
		t.Fatalf("paths: %+v", m)
	}
	if m.FSType != "virtiofs" || m.Source != "work" || !m.HasOption("ro") || !m.HasOption("nosymfollow") {
		t.Fatalf("fs: %+v", m)
	}
	if ms[0].FSType != "erofs" || ms[0].Source != "/dev/vda" {
		t.Fatalf("optional fields not skipped: %+v", ms[0])
	}
}

func TestParseUnescapesOctal(t *testing.T) {
	ms, err := Parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	if got := ms[4].Root; got != "/tab\tand\nnewline\\slash" {
		t.Fatalf("root %q", got)
	}
}

func TestParseRefusesMalformedLines(t *testing.T) {
	for _, line := range []string{
		"22 1 254:0 / / ro shared:1 erofs /dev/vda ro", // no separator
		"x 1 254:0 / / ro - erofs /dev/vda ro",
		"22 1 2540 / / ro - erofs /dev/vda ro",
		"22 1 254:0 / / ro -",
	} {
		if _, err := Parse([]byte(line + "\n")); err == nil {
			t.Errorf("parsed %q", line)
		}
	}
}

type vectors struct {
	Destinations []struct {
		In      string `json:"in"`
		Out     string `json:"out"`
		Refused bool   `json:"refused"`
	} `json:"destinations"`
	Cases []struct {
		Name     string       `json:"name"`
		Share    string       `json:"share"`
		Approved []proto.Bind `json:"approved"`
		Mounts   []OCIMount   `json:"mounts"`
		OK       bool         `json:"ok"`
	} `json:"cases"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile("testdata/binds.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Destinations) == 0 || len(v.Cases) == 0 {
		t.Fatal("no vectors")
	}
	return v
}

func TestNormalizeDestinationVectors(t *testing.T) {
	for _, d := range loadVectors(t).Destinations {
		got, ok := NormalizeDestination(d.In)
		if d.Refused {
			if ok {
				t.Errorf("%q: got %q, want refused", d.In, got)
			}
			continue
		}
		if !ok || got != d.Out {
			t.Errorf("%q: got %q (%v), want %q", d.In, got, ok, d.Out)
		}
	}
}

func TestMatchConfigVectors(t *testing.T) {
	for _, c := range loadVectors(t).Cases {
		_, err := MatchConfig(c.Share, c.Mounts, c.Approved)
		if c.OK && err != nil {
			t.Errorf("%s: refused: %v", c.Name, err)
		}
		if !c.OK && err == nil {
			t.Errorf("%s: accepted", c.Name)
		}
	}
}

func TestMatchConfigNamesTheUnapprovedBind(t *testing.T) {
	_, err := MatchConfig("/S/_work", []OCIMount{{Destination: "/d/", Type: "bind", Source: "/S/_work/x", Options: []string{"rbind"}}}, nil)
	want := "localmost: bind /S/_work/x -> /d was not approved for this container"
	if err == nil || err.Error() != want {
		t.Fatalf("got %v, want %q", err, want)
	}
}

func TestMatchConfigPairsEachShareMountWithItsApproval(t *testing.T) {
	approved := []proto.Bind{{Source: "/S/_work/a", Destination: "/one", ReadOnly: false}, {Source: "/S/_work/a", Destination: "/two", ReadOnly: true}}
	mounts := []OCIMount{
		{Destination: "/etc/hosts", Source: "/var/lib/docker/x", Options: []string{"rbind"}},
		{Destination: "/two", Source: "/S/_work/a", Options: []string{"rbind", "ro"}},
		{Destination: "/one", Source: "/S/_work/a", Options: []string{"rbind"}},
	}
	pairs, err := MatchConfig("/S/_work", mounts, approved)
	if err != nil {
		t.Fatal(err)
	}
	if len(pairs) != 2 || pairs[0].Approval != 1 || pairs[1].Approval != 0 {
		t.Fatalf("pairs %+v", pairs)
	}
}

func TestShareMountsTakesOnlyTheShareSuperblockUnderTheRootfs(t *testing.T) {
	ms, _ := Parse([]byte(sample))
	got := ShareMounts(ms, 0, 42, "/var/lib/docker/overlay2/abc/merged")
	if len(got) != 2 || got[0].ID != 90 || got[1].ID != 91 {
		t.Fatalf("got %+v", got)
	}
	// The rootfs mount point itself is never a bind destination.
	if n := len(ShareMounts(ms, 0, 42, "/var/lib/docker/overlay2/abc/merged/data")); n != 0 {
		t.Fatalf("a mount at the rootfs itself was taken: %d", n)
	}
}

func TestMatchMountinfo(t *testing.T) {
	share := "/Users/me/.localmost/runner/sandbox/3-0123456789ab/_work"
	rootfs := "/var/lib/docker/overlay2/abc/merged"
	ms, _ := Parse([]byte(sample))
	sm := ShareMounts(ms, 0, 42, rootfs)[:1]
	approved := []proto.Bind{{Source: share + "/r/r/my data", Destination: "/data", ReadOnly: true}}
	got, err := MatchMountinfo(share, rootfs, sm, approved)
	if err != nil || len(got) != 1 || got[0].Mount.ID != 90 {
		t.Fatalf("got %+v, %v", got, err)
	}
	// An approval at another destination does not cover it.
	other := []proto.Bind{{Source: share + "/r/r/my data", Destination: "/elsewhere", ReadOnly: true}}
	if _, err := MatchMountinfo(share, rootfs, sm, other); err == nil || !strings.Contains(err.Error(), "was not approved") {
		t.Fatalf("got %v", err)
	}
	// One approval cannot cover two mounts.
	twice := append(append([]Mount{}, sm...), sm[0])
	twice[1].ID = 99
	if _, err := MatchMountinfo(share, rootfs, twice, approved); err == nil {
		t.Fatal("one approval covered two mounts")
	}
	// A mount whose root is a deleted directory never matches.
	deleted := append([]Mount{}, sm...)
	deleted[0].Root = "/r/r/my data//deleted"
	if _, err := MatchMountinfo(share, rootfs, deleted, approved); err == nil {
		t.Fatal("a deleted root matched")
	}
}
