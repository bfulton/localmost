package bindpin

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/bfulton/localmost/guest/internal/mountinfo"
	"github.com/bfulton/localmost/guest/internal/proto"
)

const (
	sharePath = "/Users/me/.localmost/runner/sandbox/3-0123456789ab/_work"
	rootfs    = "/var/lib/docker/overlay2/abc/merged"
	bundle    = "/run/containerd/io.containerd.runtime.v2.task/moby/c"
)

var cid = strings.Repeat("ab", 32)

type fakeNS struct {
	mounts   []mountinfo.Mount
	openErr  map[string]error
	ids      map[string]int
	unpinned []string
	unpinErr error
}

func (f *fakeNS) Mountinfo() ([]mountinfo.Mount, error) { return f.mounts, nil }
func (f *fakeNS) Open(root, rel string) (Handle, error) {
	if root != rootfs {
		return nil, fmt.Errorf("opened beneath %s", root)
	}
	if err := f.openErr[rel]; err != nil {
		return nil, err
	}
	return rel, nil
}
func (f *fakeNS) MountID(h Handle) (int, error) { return f.ids[h.(string)], nil }
func (f *fakeNS) Unpin(h Handle) error {
	if f.unpinErr != nil {
		return f.unpinErr
	}
	f.unpinned = append(f.unpinned, h.(string))
	return nil
}
func (f *fakeNS) Close(Handle) {}

type fakeDeps struct {
	config   Config
	share    *Share
	binds    []proto.Bind
	bindsErr error
	ns       *fakeNS
	entered  bool
}

func (d *fakeDeps) ReadFile(p string, max int64) ([]byte, error) {
	if p != bundle+"/config.json" {
		return nil, fmt.Errorf("read %s", p)
	}
	return json.Marshal(d.config)
}
func (d *fakeDeps) FindShare() (Share, bool, error) {
	if d.share == nil {
		return Share{}, false, nil
	}
	return *d.share, true, nil
}
func (d *fakeDeps) Binds(string) ([]proto.Bind, error) { return d.binds, d.bindsErr }
func (d *fakeDeps) Enter(pid int) (Namespace, error) {
	d.entered = true
	return d.ns, nil
}

func shareMount(id int, root, dest string, opts ...string) mountinfo.Mount {
	if len(opts) == 0 {
		opts = []string{"rw", "nosymfollow"}
	}
	return mountinfo.Mount{ID: id, Parent: 1, Major: 0, Minor: 42, Root: root, MountPoint: rootfs + dest, FSType: "virtiofs", Source: "work", Options: opts}
}

// A container with two approved binds of the share, as runc left it.
func twoBinds() *fakeDeps {
	cfg := Config{Mounts: []mountinfo.OCIMount{
		{Destination: "/proc", Type: "proc", Source: "proc"},
		{Destination: "/a", Type: "bind", Source: sharePath + "/a", Options: []string{"rbind"}},
		{Destination: "/b", Type: "bind", Source: sharePath + "/b", Options: []string{"rbind", "ro"}},
	}}
	cfg.Root.Path = rootfs
	return &fakeDeps{
		config: cfg,
		share:  &Share{Path: sharePath, Major: 0, Minor: 42},
		binds: []proto.Bind{
			{Source: sharePath + "/a", Destination: "/a"},
			{Source: sharePath + "/b", Destination: "/b", ReadOnly: true},
		},
		ns: &fakeNS{
			mounts: []mountinfo.Mount{
				{ID: 60, Major: 0, Minor: 42, Root: "/", MountPoint: sharePath, FSType: "virtiofs", Source: "work"},
				shareMount(90, "/a", "/a"),
				shareMount(91, "/b", "/b", "ro", "nosymfollow"),
			},
			ids: map[string]int{"a": 90, "b": 91},
		},
	}
}

func state() *strings.Reader {
	b, _ := json.Marshal(State{ID: cid, Pid: 4242, Bundle: bundle})
	return strings.NewReader(string(b))
}

func TestApprovedBindsAreUnpinned(t *testing.T) {
	d := twoBinds()
	if err := Run(state(), d); err != nil {
		t.Fatal(err)
	}
	if strings.Join(d.ns.unpinned, ",") != "a,b" {
		t.Fatalf("unpinned %v", d.ns.unpinned)
	}
}

func TestAnUnreachableAgentFailsWhenAShareMountIsPresent(t *testing.T) {
	d := twoBinds()
	d.bindsErr = errors.New("dial unix /run/localmost/agent.sock: connect: no such file or directory")
	err := Run(state(), d)
	if err == nil || !strings.Contains(err.Error(), "approvals could not be read") {
		t.Fatalf("got %v", err)
	}
	if d.entered || len(d.ns.unpinned) != 0 {
		t.Fatal("went on after the agent failed")
	}
}

func TestAnUnreachableAgentIsFineWithNoShareMount(t *testing.T) {
	d := twoBinds()
	d.config.Mounts = d.config.Mounts[:1]
	d.ns.mounts = d.ns.mounts[:1]
	d.bindsErr = errors.New("unreachable")
	if err := Run(state(), d); err != nil {
		t.Fatalf("got %v", err)
	}
}

func TestAShareMountTheConfigDoesNotNameStillNeedsAnApproval(t *testing.T) {
	// A volume whose device is a share path reaches the container as a
	// share mount while its config.json source is under /var/lib/docker.
	d := twoBinds()
	d.config.Mounts = d.config.Mounts[:1]
	d.binds = nil
	err := Run(state(), d)
	if err == nil || !strings.Contains(err.Error(), "was not approved") {
		t.Fatalf("got %v", err)
	}
	if len(d.ns.unpinned) != 0 {
		t.Fatal("unpinned something")
	}
}

func TestAnUnapprovedBindFailsWithTheContractMessage(t *testing.T) {
	d := twoBinds()
	d.binds = d.binds[:1]
	err := Run(state(), d)
	want := "localmost: bind " + sharePath + "/b -> /b was not approved for this container"
	if err == nil || err.Error() != want {
		t.Fatalf("got %v", err)
	}
	if d.entered {
		t.Fatal("entered the namespace after the config check failed")
	}
}

func TestNoFlagIsClearedIfAnyMountFails(t *testing.T) {
	d := twoBinds()
	d.ns.openErr = map[string]error{"b": errors.New("ELOOP")}
	if err := Run(state(), d); err == nil {
		t.Fatal("accepted")
	}
	if len(d.ns.unpinned) != 0 {
		t.Fatalf("unpinned %v before every mount passed", d.ns.unpinned)
	}
}

func TestAMountWhoseIDDiffersIsRefused(t *testing.T) {
	d := twoBinds()
	d.ns.ids["b"] = 77
	err := Run(state(), d)
	if err == nil || !strings.Contains(err.Error(), "is mount 77, not the 91") {
		t.Fatalf("got %v", err)
	}
	if len(d.ns.unpinned) != 0 {
		t.Fatalf("unpinned %v", d.ns.unpinned)
	}
}

func TestAnUnpinFailureFails(t *testing.T) {
	d := twoBinds()
	d.ns.unpinErr = errors.New("EPERM")
	if err := Run(state(), d); err == nil {
		t.Fatal("accepted")
	}
}

func TestNoShareMeansNothingToDo(t *testing.T) {
	d := twoBinds()
	d.share = nil
	d.bindsErr = errors.New("no agent")
	if err := Run(state(), d); err != nil || d.entered {
		t.Fatalf("got %v, entered %v", err, d.entered)
	}
}

func TestMalformedState(t *testing.T) {
	for _, s := range []string{"", "{", `{"id":"x","pid":0,"bundle":"/b"}`, `{"id":"x","pid":1,"bundle":"rel"}`} {
		if err := Run(strings.NewReader(s), twoBinds()); err == nil {
			t.Errorf("%q accepted", s)
		}
	}
}

func TestFindShare(t *testing.T) {
	all := []mountinfo.Mount{
		{ID: 1, Root: "/", MountPoint: "/", FSType: "erofs", Source: "/dev/vda"},
		{ID: 5, Root: "/", MountPoint: "/Users", FSType: "tmpfs", Source: "tmpfs"},
		{ID: 6, Major: 0, Minor: 42, Root: "/", MountPoint: sharePath, FSType: "virtiofs", Source: "work"},
		{ID: 7, Major: 0, Minor: 43, Root: "/", MountPoint: "/run/rosetta", FSType: "virtiofs", Source: "rosetta"},
	}
	s, ok, err := FindShare(all)
	if err != nil || !ok || s.Path != sharePath || s.Minor != 42 {
		t.Fatalf("got %+v %v %v", s, ok, err)
	}
	if _, ok, _ := FindShare(all[:2]); ok {
		t.Fatal("found a share where there is none")
	}
	if _, _, err := FindShare(append(all, all[2])); err == nil {
		t.Fatal("a share mounted twice was accepted")
	}
}
