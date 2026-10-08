//go:build !linux

package main

import "errors"

func run([]string) (string, error) { return "", errors.New("netprobe runs only in a Linux container") }
