package bindpin

import (
	"testing"

	"github.com/bfulton/localmost/guest/internal/mountinfo"
)

func TestFindShareTakesOnlyVirtiofs(t *testing.T) {
	// A mount of another filesystem whose source happens to read "work"
	// (a tmpfs, or a mount a container made) is not the share.
	all := []mountinfo.Mount{
		{ID: 5, Major: 0, Minor: 30, Root: "/", MountPoint: "/Users", FSType: "tmpfs", Source: "work"},
		{ID: 6, Major: 0, Minor: 42, Root: "/", MountPoint: sharePath, FSType: "virtiofs", Source: "work"},
	}
	s, ok, err := FindShare(all)
	if err != nil || !ok || s.Minor != 42 {
		t.Fatalf("got %+v %v %v", s, ok, err)
	}
	if _, ok, err := FindShare(all[:1]); ok || err != nil {
		t.Fatalf("a tmpfs named work was taken for the share: %v %v", ok, err)
	}
}
