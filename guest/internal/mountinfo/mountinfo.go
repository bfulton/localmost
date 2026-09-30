// Package mountinfo parses /proc/<pid>/mountinfo and matches a container's
// share-backed mounts against the binds the filter approved (contract §3.7,
// the design's share layout rule 7). It is portable: the syscalls that act
// on what it decides live in the lm-bindpin command.
package mountinfo

import (
	"bytes"
	"fmt"
	"path"
	"strconv"
	"strings"

	"github.com/bfulton/localmost/guest/internal/proto"
)

// Mount is one line of mountinfo.
type Mount struct {
	ID, Parent   int
	Major, Minor int
	// Root is the mount's root within its filesystem, unescaped.
	Root string
	// MountPoint is relative to the reading process's root, unescaped.
	MountPoint string
	Options    []string
	FSType     string
	Source     string
	SuperOpts  string
}

// HasOption reports whether the per-mount options include o.
func (m Mount) HasOption(o string) bool {
	for _, x := range m.Options {
		if x == o {
			return true
		}
	}
	return false
}

// unescape reverses the kernel's octal escaping of space, tab, newline and
// backslash (\040, \011, \012, \134) in mountinfo paths.
func unescape(s string) (string, error) {
	if !strings.Contains(s, `\`) {
		return s, nil
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' {
			b.WriteByte(s[i])
			continue
		}
		if i+4 > len(s) {
			return "", fmt.Errorf("truncated escape in %q", s)
		}
		v, err := strconv.ParseUint(s[i+1:i+4], 8, 8)
		if err != nil {
			return "", fmt.Errorf("bad escape in %q", s)
		}
		b.WriteByte(byte(v))
		i += 3
	}
	return b.String(), nil
}

// Parse reads every line of a mountinfo file.
func Parse(data []byte) ([]Mount, error) {
	var out []Mount
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		m, err := parseLine(string(line))
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

func parseLine(line string) (Mount, error) {
	f := strings.Split(line, " ")
	sep := -1
	for i := 6; i < len(f); i++ {
		if f[i] == "-" {
			sep = i
			break
		}
	}
	// Six fixed fields, optional fields, "-", then fstype, source and
	// super options.
	if sep < 0 || sep+3 != len(f)-1 {
		return Mount{}, fmt.Errorf("mountinfo: malformed line %q", line)
	}
	var m Mount
	var err error
	if m.ID, err = strconv.Atoi(f[0]); err != nil {
		return Mount{}, fmt.Errorf("mountinfo: bad mount id in %q", line)
	}
	if m.Parent, err = strconv.Atoi(f[1]); err != nil {
		return Mount{}, fmt.Errorf("mountinfo: bad parent id in %q", line)
	}
	mm := strings.SplitN(f[2], ":", 2)
	if len(mm) != 2 {
		return Mount{}, fmt.Errorf("mountinfo: bad device in %q", line)
	}
	if m.Major, err = strconv.Atoi(mm[0]); err != nil {
		return Mount{}, fmt.Errorf("mountinfo: bad device in %q", line)
	}
	if m.Minor, err = strconv.Atoi(mm[1]); err != nil {
		return Mount{}, fmt.Errorf("mountinfo: bad device in %q", line)
	}
	if m.Root, err = unescape(f[3]); err != nil {
		return Mount{}, err
	}
	if m.MountPoint, err = unescape(f[4]); err != nil {
		return Mount{}, err
	}
	m.Options = strings.Split(f[5], ",")
	m.FSType = f[sep+1]
	if m.Source, err = unescape(f[sep+2]); err != nil {
		return Mount{}, err
	}
	m.SuperOpts = f[sep+3]
	return m, nil
}

// NormalizeDestination cleans a bind destination as the evaluator does:
// path.posix.normalize, then any trailing "/" removed except for "/" itself.
// A destination that is not absolute is refused.
func NormalizeDestination(d string) (string, bool) {
	if !strings.HasPrefix(d, "/") {
		return "", false
	}
	return path.Clean(d), true
}

// under reports whether p is dir or lies below it, by path components.
func under(p, dir string) bool {
	return p == dir || strings.HasPrefix(p, dir+"/")
}

// ShareBacked reports whether a config.json mount source is at or below the
// share, either as written or once cleaned: a source that reaches the share
// only through "." or ".." is still share-backed, and then fails the
// byte-exact source comparison.
func ShareBacked(source, share string) bool {
	return under(source, share) || under(path.Clean(source), share)
}

// OCIMount is one entry of config.json's "mounts".
type OCIMount struct {
	Destination string   `json:"destination"`
	Type        string   `json:"type,omitempty"`
	Source      string   `json:"source,omitempty"`
	Options     []string `json:"options,omitempty"`
}

// ReadOnly is true when the mount's options mark it read-only: "ro", or
// "rro" (recursive read-only), which is what dockerd and runc write into
// config.json for a read-only bind on this version.
func (m OCIMount) ReadOnly() bool {
	for _, o := range m.Options {
		if o == "ro" || o == "rro" {
			return true
		}
	}
	return false
}

// UnapprovedError names a share-backed bind with no approval.
type UnapprovedError struct{ Source, Destination string }

func (e *UnapprovedError) Error() string {
	return fmt.Sprintf("localmost: bind %s -> %s was not approved for this container", e.Source, e.Destination)
}

// Pair is a share-backed mount (an index into the list it came from) and
// the approval (an index into the approvals) it matched.
type Pair struct {
	Mount    int
	Approval int
}

// take finds an unused approval equal to (source, destination, readOnly).
// Equal approvals are interchangeable, so the first unused one is as good
// as any.
func take(approved []proto.Bind, used []bool, source, dest string, ro bool, checkRO bool) int {
	for i, a := range approved {
		if used[i] || a.Source != source {
			continue
		}
		ad, ok := NormalizeDestination(a.Destination)
		if !ok || ad != dest {
			continue
		}
		if checkRO && a.ReadOnly != ro {
			continue
		}
		used[i] = true
		return i
	}
	return -1
}

// MatchConfig checks every share-backed mount of a container's config.json
// (step 3 of rule 7): its source byte for byte, its normalised destination,
// and its read-only flag must equal one approval, and each approval covers
// at most one mount. Mounts not on the share are ignored. It returns the
// pairs in mount order, or an *UnapprovedError for the first mount that
// fails.
func MatchConfig(share string, mounts []OCIMount, approved []proto.Bind) ([]Pair, error) {
	used := make([]bool, len(approved))
	var pairs []Pair
	for i, m := range mounts {
		if !ShareBacked(m.Source, share) {
			continue
		}
		dest, ok := NormalizeDestination(m.Destination)
		if !ok {
			return nil, &UnapprovedError{Source: m.Source, Destination: m.Destination}
		}
		a := take(approved, used, m.Source, dest, m.ReadOnly(), true)
		if a < 0 {
			return nil, &UnapprovedError{Source: m.Source, Destination: dest}
		}
		pairs = append(pairs, Pair{Mount: i, Approval: a})
	}
	return pairs, nil
}

// ShareMounts returns the mounts of the share's superblock (device
// major:minor) whose mount point lies strictly below the container rootfs,
// as seen from inside the container's mount namespace before pivot_root.
// Copies of the share outside the rootfs are the host's own mounts, which
// runc detaches with the old root.
func ShareMounts(all []Mount, major, minor int, rootfs string) []Mount {
	var out []Mount
	for _, m := range all {
		if m.Major == major && m.Minor == minor && strings.HasPrefix(m.MountPoint, rootfs+"/") {
			out = append(out, m)
		}
	}
	return out
}

// Matched is a share mount in the container and the approval it matched.
type Matched struct {
	Mount    Mount
	Approval int
}

// MatchMountinfo is step 4 of rule 7: every share mount under the rootfs
// must be one approved bind, identified by its root within the share (the
// host source) and its mount point under the rootfs (the destination), and
// each approval covers at most one mount.
func MatchMountinfo(share, rootfs string, mounts []Mount, approved []proto.Bind) ([]Matched, error) {
	used := make([]bool, len(approved))
	var out []Matched
	for _, m := range mounts {
		source := share
		if m.Root != "/" {
			source = share + m.Root
		}
		dest := strings.TrimPrefix(m.MountPoint, rootfs)
		a := take(approved, used, source, dest, false, false)
		if a < 0 {
			return nil, &UnapprovedError{Source: source, Destination: dest}
		}
		out = append(out, Matched{Mount: m, Approval: a})
	}
	return out, nil
}
