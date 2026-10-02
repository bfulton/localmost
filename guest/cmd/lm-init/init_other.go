//go:build !linux

package main

import "errors"

func initMain() error { return errors.New("lm-init runs only as the Linux guest's PID 1") }

func modprobe() int { return 1 }
