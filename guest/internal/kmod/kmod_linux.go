//go:build linux

package kmod

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// LoadList loads, in order, every module listed (relative to dir) in the
// file at list. A module that is already loaded is fine.
func LoadList(dir, list string) ([]string, error) {
	f, err := os.Open(list)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var loaded []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		rel := strings.TrimSpace(sc.Text())
		if rel == "" {
			continue
		}
		if err := Load(filepath.Join(dir, rel)); err != nil {
			return loaded, fmt.Errorf("%s: %w", rel, err)
		}
		loaded = append(loaded, NameOf(rel))
	}
	return loaded, sc.Err()
}

// Load loads one module file with finit_module.
func Load(p string) error {
	fd, err := unix.Open(p, unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if err := unix.FinitModule(fd, "", 0); err != nil && err != unix.EEXIST {
		return err
	}
	return nil
}

// Loaded reports whether a module is loaded (or built in with parameters).
func Loaded(name string) bool {
	_, err := os.Stat("/sys/module/" + Normalize(name))
	return err == nil
}

// Modprobe is /sbin/modprobe after boot: it loads nothing. It returns 0
// when every requested module is already loaded or built in, and 1
// otherwise, after writing each refused request to the kernel log.
func Modprobe(args []string, moduleDir string) int {
	names, remove := RequestedNames(args)
	if remove {
		return 0
	}
	aliasText, _ := os.ReadFile(filepath.Join(moduleDir, "modules.alias"))
	builtinText, _ := os.ReadFile(filepath.Join(moduleDir, "modules.builtin"))
	aliases, builtin := ParseAliases(string(aliasText)), ParseBuiltin(string(builtinText))
	code := 0
	for _, n := range names {
		ok := false
		mods := Resolve(n, aliases)
		for _, m := range mods {
			if builtin[m] || Loaded(m) {
				ok = true
			}
		}
		if !ok {
			code = 1
			kmsg(fmt.Sprintf("localmost: module request %q (%s) refused: module loading is disabled and it is not in the allowlist", n, strings.Join(mods, ",")))
		}
	}
	return code
}

func kmsg(msg string) {
	if f, err := os.OpenFile("/dev/kmsg", os.O_WRONLY, 0); err == nil {
		fmt.Fprintf(f, "<4>%s\n", msg)
		f.Close()
	}
}
