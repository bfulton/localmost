// Package kmod is lm-init's module handling (contract §3.2, §5.2): the
// load order the build wrote, and the modprobe that answers after loading
// is disabled. The kernel's usermode helper and dockerd both run
// /sbin/modprobe; it loads nothing, succeeds for a module that is already
// loaded or built in, and otherwise logs the refused request to the kernel
// log, so that a missing allowlist entry shows in dmesg.
package kmod

import (
	"path"
	"strings"
)

// Normalize is a module name as the kernel lists it: "-" becomes "_".
func Normalize(name string) string { return strings.ReplaceAll(name, "-", "_") }

// NameOf is the module name of a module file path.
func NameOf(p string) string {
	base := path.Base(p)
	if i := strings.Index(base, ".ko"); i >= 0 {
		base = base[:i]
	}
	return Normalize(base)
}

// Alias is one "alias <pattern> <module>" line of modules.alias.
type Alias struct{ Pattern, Module string }

// ParseAliases reads modules.alias.
func ParseAliases(text string) []Alias {
	var out []Alias
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) == 3 && f[0] == "alias" {
			out = append(out, Alias{Pattern: f[1], Module: Normalize(f[2])})
		}
	}
	return out
}

// ParseBuiltin reads modules.builtin into a set of names.
func ParseBuiltin(text string) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out[NameOf(line)] = true
		}
	}
	return out
}

// Resolve maps a requested name (a module or an alias such as
// "net-pf-17" or "fs-ext4") to module names. A name with no alias match is
// taken as a module name.
func Resolve(req string, aliases []Alias) []string {
	var out []string
	for _, a := range aliases {
		if ok, _ := path.Match(a.Pattern, req); ok {
			out = append(out, a.Module)
		}
	}
	if len(out) == 0 {
		out = []string{Normalize(req)}
	}
	return out
}

// RequestedNames are the modules a modprobe command line asks for: every
// operand with -a, else the first (the rest are parameters). Removal (-r)
// asks for nothing to be loaded.
func RequestedNames(args []string) (names []string, remove bool) {
	all := false
	var operands []string
	for i := 1; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			operands = append(operands, args[i+1:]...)
			i = len(args)
		case strings.HasPrefix(a, "--"):
			if a == "--all" {
				all = true
			}
			if a == "--remove" {
				remove = true
			}
		case strings.HasPrefix(a, "-") && len(a) > 1:
			if strings.Contains(a, "a") {
				all = true
			}
			if strings.Contains(a, "r") {
				remove = true
			}
		default:
			operands = append(operands, a)
		}
	}
	if len(operands) == 0 {
		return nil, remove
	}
	if !all {
		return operands[:1], remove
	}
	for _, o := range operands {
		if !strings.Contains(o, "=") {
			names = append(names, o)
		}
	}
	return names, remove
}
