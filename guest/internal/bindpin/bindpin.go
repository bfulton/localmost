// Package bindpin is lm-bindpin, the OCI createRuntime hook that turns
// symlink-following back on only for the binds the filter approved (the
// design's share layout rule 7, contract §3.7). The decisions are here and
// portable; the namespace, openat2, statx and mount_setattr calls are
// behind Namespace, implemented for Linux in namespace_linux.go.
package bindpin

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/bfulton/localmost/guest/internal/mountinfo"
	"github.com/bfulton/localmost/guest/internal/proto"
)

// State is the OCI state the runtime writes to a hook's stdin.
type State struct {
	ID     string `json:"id"`
	Pid    int    `json:"pid"`
	Bundle string `json:"bundle"`
}

// Config is the part of config.json the hook reads.
type Config struct {
	Root struct {
		Path string `json:"path"`
	} `json:"root"`
	Mounts []mountinfo.OCIMount `json:"mounts"`
}

// Share is the share's mount in the runtime's namespace.
type Share struct {
	Path         string
	Major, Minor int
}

// Handle is an open O_PATH descriptor on one mount inside the container.
type Handle interface{}

// Namespace is the container's mount namespace, entered by the hook.
type Namespace interface {
	// Mountinfo is the container's mount table, as seen from inside it.
	Mountinfo() ([]mountinfo.Mount, error)
	// Open opens rel beneath rootfs with no symlinks followed.
	Open(rootfs, rel string) (Handle, error)
	// MountID is statx's STATX_MNT_ID for the handle.
	MountID(h Handle) (int, error)
	// Unpin clears nosymfollow on the handle's mount (keeping ro, and
	// setting nosuid and nodev).
	Unpin(h Handle) error
	Close(h Handle)
}

// Deps is everything the hook reads from its surroundings.
type Deps interface {
	ReadFile(path string, max int64) ([]byte, error)
	// FindShare reads the runtime namespace's mount table: ok is false when
	// no share is mounted (a refresh VM).
	FindShare() (s Share, ok bool, err error)
	// Binds asks the agent for a container's approvals; nil with a nil
	// error means none were recorded.
	Binds(container string) ([]proto.Bind, error)
	// Enter enters the mount namespace of pid.
	Enter(pid int) (Namespace, error)
}

// MaxState and MaxConfig bound what the hook reads.
const (
	MaxState  = 1 << 20
	MaxConfig = 16 << 20
)

var containerRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Run is the whole hook. It returns nil only when every share-backed mount
// was checked and unpinned, or there was none.
func Run(stdin io.Reader, d Deps) error {
	raw, err := io.ReadAll(io.LimitReader(stdin, MaxState+1))
	if err != nil || len(raw) > MaxState {
		return errors.New("localmost: could not read the container state")
	}
	var st State
	if err := json.Unmarshal(raw, &st); err != nil || st.Pid <= 0 || !filepath.IsAbs(st.Bundle) {
		return errors.New("localmost: malformed container state")
	}
	share, present, err := d.FindShare()
	if err != nil {
		return fmt.Errorf("localmost: could not read the mount table: %w", err)
	}
	if !present {
		return nil
	}
	cfgRaw, err := d.ReadFile(filepath.Join(st.Bundle, "config.json"), MaxConfig)
	if err != nil {
		return fmt.Errorf("localmost: could not read the container config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(cfgRaw, &cfg); err != nil || cfg.Root.Path == "" {
		return errors.New("localmost: malformed container config")
	}
	rootfs := cfg.Root.Path
	if !filepath.IsAbs(rootfs) {
		rootfs = filepath.Join(st.Bundle, rootfs)
	}
	shareBacked := false
	for _, m := range cfg.Mounts {
		if mountinfo.ShareBacked(m.Source, share.Path) {
			shareBacked = true
			break
		}
	}
	var approved []proto.Bind
	if containerRe.MatchString(st.ID) {
		approved, err = d.Binds(st.ID)
	} else {
		err = fmt.Errorf("container id %q is not 64 hex", st.ID)
	}
	if err != nil {
		if shareBacked {
			return fmt.Errorf("localmost: the bind approvals could not be read (%v), so no bind of the workspace is allowed", err)
		}
		// With no share-backed mount in the config, carry on with no
		// approvals: any share mount found below still fails.
		approved = nil
	}
	pairs, err := mountinfo.MatchConfig(share.Path, cfg.Mounts, approved)
	if err != nil {
		return err
	}
	required := make([]int, len(pairs))
	for i, p := range pairs {
		required[i] = p.Approval
	}
	ns, err := d.Enter(st.Pid)
	if err != nil {
		return fmt.Errorf("localmost: could not enter the container's mount namespace: %w", err)
	}
	return Pin(ns, share, rootfs, approved, required)
}

// Pin is steps 4 to 6 of rule 7, inside the container's namespace: every
// share mount below the rootfs must be an approved bind, and every approval
// in required (those config.json's share-backed mounts matched) must be one
// of them, so that an approved source that runc resolved off the share (a
// link swapped in before the mount) is refused; each is opened beneath the
// rootfs and must be the mount with the recorded id; and only once all of
// them passed is nosymfollow cleared on each.
func Pin(ns Namespace, share Share, rootfs string, approved []proto.Bind, required []int) error {
	all, err := ns.Mountinfo()
	if err != nil {
		return fmt.Errorf("localmost: could not read the container's mount table: %w", err)
	}
	mounts := mountinfo.ShareMounts(all, share.Major, share.Minor, rootfs)
	matched, err := mountinfo.MatchMountinfo(share.Path, rootfs, mounts, approved)
	if err != nil {
		return err
	}
	found := map[int]bool{}
	for _, m := range matched {
		found[m.Approval] = true
	}
	for _, a := range required {
		if !found[a] {
			return fmt.Errorf("localmost: bind %s -> %s is not a mount of the share (its source resolved elsewhere)", approved[a].Source, approved[a].Destination)
		}
	}
	var handles []Handle
	defer func() {
		for _, h := range handles {
			ns.Close(h)
		}
	}()
	for _, m := range matched {
		rel := strings.TrimPrefix(m.Mount.MountPoint, rootfs+"/")
		h, err := ns.Open(rootfs, rel)
		if err != nil {
			return fmt.Errorf("localmost: bind at %s could not be opened: %w", m.Mount.MountPoint, err)
		}
		handles = append(handles, h)
		id, err := ns.MountID(h)
		if err != nil {
			return fmt.Errorf("localmost: bind at %s: %w", m.Mount.MountPoint, err)
		}
		if id != m.Mount.ID {
			return fmt.Errorf("localmost: bind at %s is mount %d, not the %d it was checked as", m.Mount.MountPoint, id, m.Mount.ID)
		}
	}
	for i, h := range handles {
		if err := ns.Unpin(h); err != nil {
			return fmt.Errorf("localmost: bind at %s could not be unpinned: %w", matched[i].Mount.MountPoint, err)
		}
	}
	return nil
}

// FindShare picks the share's own mount out of the runtime namespace's
// table: the virtiofs mount of tag "work" at its root. Two of them is an
// error, as the agent mounts it once.
func FindShare(all []mountinfo.Mount) (Share, bool, error) {
	var found []mountinfo.Mount
	for _, m := range all {
		if m.FSType == "virtiofs" && m.Source == proto.ShareTag && m.Root == "/" {
			found = append(found, m)
		}
	}
	switch len(found) {
	case 0:
		return Share{}, false, nil
	case 1:
		return Share{Path: found[0].MountPoint, Major: found[0].Major, Minor: found[0].Minor}, true, nil
	}
	return Share{}, false, errors.New("the share is mounted more than once")
}
