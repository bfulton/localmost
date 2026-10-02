//go:build !linux

package main

import "errors"

func run() error { return errors.New("lm-agent runs only in the Linux guest") }
