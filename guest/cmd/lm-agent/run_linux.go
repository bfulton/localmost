//go:build linux

package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"time"

	"golang.org/x/sys/unix"

	"github.com/bfulton/localmost/guest/internal/agent"
	"github.com/bfulton/localmost/guest/internal/relay"
	"github.com/bfulton/localmost/guest/internal/vsock"
)

const (
	controlPort = 1025
	dockerPort  = 2375
	localDir    = "/run/localmost"
	localSocket = localDir + "/agent.sock"
	dockerSock  = "/run/docker.sock"
)

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "lm-agent: "+format+"\n", args...)
}

func run() error {
	p := newPlatform(logf)
	a := agent.New(p)
	p.forget = a.Forget

	control, err := vsock.Listen(controlPort)
	if err != nil {
		return err
	}
	docker, err := vsock.Listen(dockerPort)
	if err != nil {
		return err
	}
	local, err := listenLocal()
	if err != nil {
		return err
	}
	errc := make(chan error, 3)
	go func() {
		for {
			c, err := control.Accept()
			if err != nil {
				errc <- fmt.Errorf("vsock %d: %w", controlPort, err)
				return
			}
			go a.Serve(c, false)
		}
	}()
	go func() {
		for {
			c, err := docker.Accept()
			if err != nil {
				errc <- fmt.Errorf("vsock %d: %w", dockerPort, err)
				return
			}
			go serveDocker(a.Ready, c, dialDocker)
		}
	}()
	go func() {
		for {
			c, err := local.AcceptUnix()
			if err != nil {
				errc <- fmt.Errorf("%s: %w", localSocket, err)
				return
			}
			if !peerIsRoot(c) {
				c.Close()
				continue
			}
			go a.Serve(c, true)
		}
	}()
	logf("listening on vsock %d and %d, and %s", controlPort, dockerPort, localSocket)
	return <-errc
}

// dialDocker connects to dockerd's socket for one host connection.
func dialDocker() (relay.Conn, error) {
	d, err := net.DialTimeout("unix", dockerSock, 5*time.Second)
	if err != nil {
		return nil, err
	}
	return d.(*net.UnixConn), nil
}

func listenLocal() (*net.UnixListener, error) {
	if err := os.MkdirAll(localDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(localDir, 0o700); err != nil {
		return nil, err
	}
	os.Remove(localSocket)
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: localSocket, Net: "unix"})
	if err != nil {
		return nil, err
	}
	return l, os.Chmod(localSocket, 0o600)
}

func peerIsRoot(c *net.UnixConn) bool {
	raw, err := c.SyscallConn()
	if err != nil {
		return false
	}
	var cred *unix.Ucred
	if cerr := raw.Control(func(fd uintptr) {
		cred, err = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); cerr != nil {
		return false
	}
	if err == nil && cred == nil {
		err = errors.New("no peer credentials")
	}
	var uid uint32 = 1
	if cred != nil {
		uid = cred.Uid
	}
	return rootPeer(uid, err)
}
