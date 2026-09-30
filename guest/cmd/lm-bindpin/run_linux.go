//go:build linux

package main

import (
	"os"

	"github.com/bfulton/localmost/guest/internal/bindpin"
)

func run() error { return bindpin.Run(os.Stdin, bindpin.LinuxDeps{}) }
