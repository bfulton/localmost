//go:build linux

package bindpin

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"runtime"
	"strconv"
	"time"

	"golang.org/x/sys/unix"

	"github.com/bfulton/localmost/guest/internal/mountinfo"
	"github.com/bfulton/localmost/guest/internal/proto"
)

// AgentSocket is the agent's guest-local socket (contract §3.4).
const AgentSocket = "/run/localmost/agent.sock"

// LinuxDeps is Deps on the running guest.
type LinuxDeps struct {
	// AgentSocket overrides the agent's socket path (tests).
	AgentSocket string
}

func (d LinuxDeps) ReadFile(p string, max int64) ([]byte, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("%s is larger than %d bytes", p, max)
	}
	return b, nil
}

func (d LinuxDeps) FindShare() (Share, bool, error) {
	b, err := d.ReadFile("/proc/self/mountinfo", 4<<20)
	if err != nil {
		return Share{}, false, err
	}
	all, err := mountinfo.Parse(b)
	if err != nil {
		return Share{}, false, err
	}
	return FindShare(all)
}

func (d LinuxDeps) Binds(container string) ([]proto.Bind, error) {
	sock := d.AgentSocket
	if sock == "" {
		sock = AgentSocket
	}
	c, err := net.DialTimeout("unix", sock, 3*time.Second)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	req, _ := json.Marshal(map[string]any{"v": 1, "id": 1, "op": "binds-for", "container": container})
	if _, err := c.Write(append(req, '\n')); err != nil {
		return nil, err
	}
	line, err := proto.NewLineReader(bufio.NewReader(c)).Next()
	if err != nil {
		return nil, err
	}
	var ans struct {
		V     int           `json:"v"`
		ID    int           `json:"id"`
		OK    bool          `json:"ok"`
		Binds *[]proto.Bind `json:"binds"`
	}
	if err := json.Unmarshal(line, &ans); err != nil || ans.V != 1 || ans.ID != 1 || !ans.OK {
		return nil, errors.New("the agent's answer is not a valid list")
	}
	if ans.Binds == nil {
		return nil, nil
	}
	return *ans.Binds, nil
}

// Enter locks the calling goroutine to its thread, gives the thread its own
// fs_struct (unshare CLONE_FS, which setns into a mount namespace needs in a
// multithreaded process), and joins pid's mount namespace. The thread is
// never unlocked: it exits with the goroutine, so no other goroutine runs
// in the container's namespace. Every Namespace call must be made from the
// goroutine that called Enter.
func (d LinuxDeps) Enter(pid int) (Namespace, error) {
	runtime.LockOSThread()
	if err := unix.Unshare(unix.CLONE_FS); err != nil {
		return nil, fmt.Errorf("unshare(CLONE_FS): %w", err)
	}
	fd, err := unix.Open("/proc/"+strconv.Itoa(pid)+"/ns/mnt", unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	if err := unix.Setns(fd, unix.CLONE_NEWNS); err != nil {
		return nil, fmt.Errorf("setns: %w", err)
	}
	return &linuxNS{rootfd: -1}, nil
}

type linuxNS struct {
	rootfd   int
	rootPath string
}

func (n *linuxNS) Mountinfo() ([]mountinfo.Mount, error) {
	b, err := os.ReadFile("/proc/thread-self/mountinfo")
	if err != nil {
		return nil, err
	}
	return mountinfo.Parse(b)
}

const resolveStrict = unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS

// Open opens rel beneath the container rootfs with O_PATH, following no
// symlink and never leaving the rootfs. The rootfs itself is opened once,
// also without following a symlink.
func (n *linuxNS) Open(rootfs, rel string) (Handle, error) {
	if n.rootfd < 0 || n.rootPath != rootfs {
		if n.rootfd >= 0 {
			unix.Close(n.rootfd)
		}
		fd, err := unix.Openat2(unix.AT_FDCWD, rootfs, &unix.OpenHow{
			Flags: unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: resolveStrict,
		})
		if err != nil {
			return nil, fmt.Errorf("open rootfs: %w", err)
		}
		n.rootfd, n.rootPath = fd, rootfs
	}
	fd, err := unix.Openat2(n.rootfd, rel, &unix.OpenHow{
		Flags: unix.O_PATH | unix.O_CLOEXEC | unix.O_NOFOLLOW, Resolve: resolveStrict | unix.RESOLVE_BENEATH,
	})
	if err != nil {
		return nil, err
	}
	return fd, nil
}

func (n *linuxNS) MountID(h Handle) (int, error) {
	var stx unix.Statx_t
	if err := unix.Statx(h.(int), "", unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW, unix.STATX_MNT_ID, &stx); err != nil {
		return 0, fmt.Errorf("statx: %w", err)
	}
	if stx.Mask&unix.STATX_MNT_ID == 0 {
		return 0, errors.New("statx gave no mount id")
	}
	return int(stx.Mnt_id), nil
}

// Unpin clears nosymfollow on the mount the handle is, and nothing else it
// had: ro is kept, and nosuid and nodev are set whatever runc's remount did.
func (n *linuxNS) Unpin(h Handle) error {
	return unix.MountSetattr(h.(int), "", unix.AT_EMPTY_PATH, &unix.MountAttr{
		Attr_clr: unix.MOUNT_ATTR_NOSYMFOLLOW,
		Attr_set: unix.MOUNT_ATTR_NOSUID | unix.MOUNT_ATTR_NODEV,
	})
}

func (n *linuxNS) Close(h Handle) { unix.Close(h.(int)) }
