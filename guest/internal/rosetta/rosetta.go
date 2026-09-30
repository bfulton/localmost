// Package rosetta registers Rosetta for Linux with binfmt_misc (contract
// §3.4 step 4). The host adds the "rosetta" share only when Rosetta is
// installed; the agent mounts it, registers the interpreter with flags CF
// (F alone gives EINVAL), and runs a static x86-64 binary to see that it
// works. The result never fails configure.
package rosetta

// Register is written to /proc/sys/fs/binfmt_misc/register, exactly as the
// contract gives it. binfmt_misc decodes the \x escapes itself.
const Register = `:rosetta:M::\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00:\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/run/rosetta/rosetta:CF`

// Results.
const (
	OK     = "ok"
	Absent = "absent"
	Broken = "broken"
)

// Paths in the guest.
const (
	MountPoint = "/run/rosetta"
	Selftest   = "/usr/libexec/localmost/x86_64/busybox"
)
