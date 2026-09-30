// Package share checks and mounts the job's share (contract §3.4 step 3,
// the design's share layout rules 5 and 6). The share is mounted at the
// same absolute path it has on the Mac, under a tmpfs on its top-level
// directory, with nosuid, nodev and nosymfollow.
package share

import (
	"fmt"
	"strings"
)

// MaxPathLen is the longest mount path configure accepts.
const MaxPathLen = 1024

// MountRoots are the top-level directories a share may be mounted under.
// The read-only root has each as an empty directory, which is only ever a
// mount point for the tmpfs; every other top-level name is refused, so the
// tmpfs can never hide a directory the guest uses (/usr, /var, /etc, ...).
// They are where a Mac's home directories live, /Users, and /Volumes for a
// home on another volume, and /private, where the Mac's temporary
// directories resolve (os.tmpdir() and /tmp, where the e2e tests keep
// their data directory). The Linux root has no /private, so covering it
// hides nothing.
var MountRoots = []string{"Users", "Volumes", "private"}

// CheckMountPath refuses a mount path that is not absolute and normalised
// (no ".", "..", empty component, trailing "/" or NUL), is longer than
// 1024 bytes, or whose top-level component is not one of MountRoots, or is
// only that component. It returns the top-level component.
func CheckMountPath(p string) (string, error) {
	if len(p) > MaxPathLen {
		return "", fmt.Errorf("the share path is longer than %d bytes", MaxPathLen)
	}
	if !strings.HasPrefix(p, "/") || p == "/" || strings.ContainsRune(p, 0) {
		return "", fmt.Errorf("the share path %q is not an absolute path below /", p)
	}
	parts := strings.Split(p[1:], "/")
	for _, c := range parts {
		if c == "" || c == "." || c == ".." {
			return "", fmt.Errorf("the share path %q is not normalised", p)
		}
	}
	allowed := false
	for _, r := range MountRoots {
		if parts[0] == r {
			allowed = true
		}
	}
	if !allowed {
		return "", fmt.Errorf("the share path's top-level directory /%s is not one of /%s", parts[0], strings.Join(MountRoots, ", /"))
	}
	if len(parts) < 2 {
		return "", fmt.Errorf("the share path %q is a mount root itself", p)
	}
	return parts[0], nil
}
