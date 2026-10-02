package bindpin

import (
	"strings"
	"testing"

	"github.com/bfulton/localmost/guest/internal/mountinfo"
)

func TestAnApprovedBindThatIsNotAShareMountIsRefused(t *testing.T) {
	// The approved source /b was swapped for a link to /run before runc
	// mounted it: config.json still names the share path, but what is at
	// /b in the container is the guest's /run (a tmpfs), not the share.
	d := twoBinds()
	d.ns.mounts[2] = mountinfo.Mount{ID: 91, Parent: 1, Major: 0, Minor: 26, Root: "/", MountPoint: rootfs + "/b", FSType: "tmpfs", Source: "tmpfs", Options: []string{"rw"}}
	err := Run(state(), d)
	want := "localmost: bind " + sharePath + "/b -> /b is not a mount of the share"
	if err == nil || !strings.HasPrefix(err.Error(), want) {
		t.Fatalf("got %v, want %q", err, want)
	}
	if len(d.ns.unpinned) != 0 {
		t.Fatalf("unpinned %v", d.ns.unpinned)
	}
}
