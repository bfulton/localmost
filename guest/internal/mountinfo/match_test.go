package mountinfo

import (
	"testing"

	"github.com/bfulton/localmost/guest/internal/proto"
)

func TestMatchMountinfoChecksTheMountsReadOnlyFlag(t *testing.T) {
	// The config.json layer checks ro only for sources lexically on the
	// share; a share mount that got there another way is caught here, and
	// its read-only flag must match too.
	share := "/S/_work"
	rootfs := "/var/lib/docker/overlay2/abc/merged"
	rw := Mount{ID: 90, Major: 0, Minor: 42, Root: "/a", MountPoint: rootfs + "/data", FSType: "virtiofs", Source: "work", Options: []string{"rw", "nosuid"}}
	ro := rw
	ro.Options = []string{"ro", "nosuid"}
	roApproval := []proto.Bind{{Source: share + "/a", Destination: "/data", ReadOnly: true}}
	rwApproval := []proto.Bind{{Source: share + "/a", Destination: "/data", ReadOnly: false}}
	if _, err := MatchMountinfo(share, rootfs, []Mount{rw}, roApproval); err == nil {
		t.Fatal("a read-write mount matched a read-only approval")
	}
	if _, err := MatchMountinfo(share, rootfs, []Mount{ro}, rwApproval); err == nil {
		t.Fatal("a read-only mount matched a read-write approval")
	}
	if _, err := MatchMountinfo(share, rootfs, []Mount{ro}, roApproval); err != nil {
		t.Fatalf("a read-only mount did not match its read-only approval: %v", err)
	}
	if _, err := MatchMountinfo(share, rootfs, []Mount{rw}, rwApproval); err != nil {
		t.Fatalf("a read-write mount did not match its read-write approval: %v", err)
	}
}

func TestShareMountsSkipsOtherFilesystemsUnderTheRootfs(t *testing.T) {
	rootfs := "/var/lib/docker/overlay2/abc/merged"
	table := `61 60 0:42 / /S/_work rw,nosuid,nodev,nosymfollow - virtiofs work rw
90 88 0:42 /a /var/lib/docker/overlay2/abc/merged/data rw,nosuid - virtiofs work rw
91 88 0:43 / /var/lib/docker/overlay2/abc/merged/dev rw,nosuid - tmpfs tmpfs rw
92 88 254:16 /containers/x/hosts /var/lib/docker/overlay2/abc/merged/etc/hosts rw - ext4 /dev/vdb rw
93 88 0:42 /b /var/lib/docker/overlay2/abc/mergedx/y rw - virtiofs work rw
`
	ms, err := Parse([]byte(table))
	if err != nil {
		t.Fatal(err)
	}
	got := ShareMounts(ms, 0, 42, rootfs)
	if len(got) != 1 || got[0].ID != 90 {
		t.Fatalf("got %+v", got)
	}
}
