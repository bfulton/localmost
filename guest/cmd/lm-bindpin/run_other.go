//go:build !linux

package main

import "errors"

// The hook runs only in the Linux guest; elsewhere it refuses, as it would
// on any error.
func run() error { return errors.New("localmost: lm-bindpin runs only in the Linux guest") }
