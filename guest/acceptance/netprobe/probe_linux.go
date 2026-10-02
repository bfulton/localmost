//go:build linux

package main

import (
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"math/rand"
	"net"
	"os"
	"strconv"
	"time"

	"golang.org/x/sys/unix"
)

func run(args []string) (string, error) {
	if len(args) == 0 {
		return "", errors.New("no command")
	}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	dev := fs.String("dev", "", "interface to bind to")
	if err := fs.Parse(args[1:]); err != nil {
		return "", err
	}
	rest := fs.Args()
	switch args[0] {
	case "connect":
		ip, port, err := target(rest)
		if err != nil {
			return "", err
		}
		return connect(*dev, ip, port), nil
	case "rawsyn":
		ip, port, err := target(rest)
		if err != nil {
			return "", err
		}
		if *dev == "" {
			return "", errors.New("rawsyn needs -dev")
		}
		return rawSyn(*dev, ip, port)
	case "vsock":
		if len(rest) != 2 {
			return "", errors.New("vsock CID PORT")
		}
		cid, err1 := strconv.ParseUint(rest[0], 10, 32)
		port, err2 := strconv.ParseUint(rest[1], 10, 32)
		if err1 != nil || err2 != nil {
			return "", errors.New("bad CID or port")
		}
		return vsock(uint32(cid), uint32(port)), nil
	case "listen":
		if len(rest) != 1 {
			return "", errors.New("listen PORT")
		}
		return "", listen(rest[0])
	}
	return "", fmt.Errorf("unknown command %q", args[0])
}

func target(rest []string) ([4]byte, int, error) {
	var ip [4]byte
	if len(rest) != 2 {
		return ip, 0, errors.New("IP PORT")
	}
	p := net.ParseIP(rest[0]).To4()
	port, err := strconv.Atoi(rest[1])
	if p == nil || err != nil || port <= 0 || port > 65535 {
		return ip, 0, errors.New("bad IP or port")
	}
	copy(ip[:], p)
	return ip, port, nil
}

func errnoName(err error) string {
	var e unix.Errno
	if errors.As(err, &e) {
		if n := unix.ErrnoName(e); n != "" {
			return n
		}
	}
	return err.Error()
}

// connect makes one TCP connection and reports how it ended.
func connect(dev string, ip [4]byte, port int) string {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_STREAM|unix.SOCK_NONBLOCK|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return errnoName(err)
	}
	defer unix.Close(fd)
	if dev != "" {
		if err := unix.BindToDevice(fd, dev); err != nil {
			return "bind " + errnoName(err)
		}
	}
	err = unix.Connect(fd, &unix.SockaddrInet4{Port: port, Addr: ip})
	if err == nil {
		return "connected"
	}
	if err != unix.EINPROGRESS {
		return errnoName(err)
	}
	fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLOUT}}
	n, err := unix.Poll(fds, 5000)
	if err != nil {
		return errnoName(err)
	}
	if n == 0 {
		return "timeout"
	}
	soErr, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_ERROR)
	if err != nil {
		return errnoName(err)
	}
	if soErr != 0 {
		return errnoName(unix.Errno(soErr))
	}
	return "connected"
}

func checksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(b[i:]))
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = sum&0xffff + sum>>16
	}
	return ^uint16(sum)
}

func ifaceAddr(dev string) ([4]byte, error) {
	var out [4]byte
	ifi, err := net.InterfaceByName(dev)
	if err != nil {
		return out, err
	}
	addrs, err := ifi.Addrs()
	if err != nil {
		return out, err
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil {
			copy(out[:], n.IP.To4())
			return out, nil
		}
	}
	return out, fmt.Errorf("%s has no IPv4 address", dev)
}

// rawSyn sends one hand-made SYN out of dev and waits 3 s for the answer:
// "rst" (refused), "synack" (something accepted it) or "none".
func rawSyn(dev string, dst [4]byte, dport int) (string, error) {
	src, err := ifaceAddr(dev)
	if err != nil {
		return "", err
	}
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_RAW|unix.SOCK_CLOEXEC, unix.IPPROTO_TCP)
	if err != nil {
		return "socket " + errnoName(err), nil
	}
	defer unix.Close(fd)
	if err := unix.BindToDevice(fd, dev); err != nil {
		return "bind " + errnoName(err), nil
	}
	sport := 40000 + rand.Intn(20000)
	seq := rand.Uint32()
	tcp := make([]byte, 20)
	binary.BigEndian.PutUint16(tcp[0:], uint16(sport))
	binary.BigEndian.PutUint16(tcp[2:], uint16(dport))
	binary.BigEndian.PutUint32(tcp[4:], seq)
	tcp[12] = 5 << 4
	tcp[13] = 0x02 // SYN
	binary.BigEndian.PutUint16(tcp[14:], 64240)
	pseudo := append(append(append([]byte{}, src[:]...), dst[:]...), 0, unix.IPPROTO_TCP, 0, 20)
	binary.BigEndian.PutUint16(tcp[16:], checksum(append(pseudo, tcp...)))
	if err := unix.Sendto(fd, tcp, 0, &unix.SockaddrInet4{Addr: dst}); err != nil {
		return "send " + errnoName(err), nil
	}
	tv := unix.NsecToTimeval(int64(200 * time.Millisecond))
	unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &tv)
	deadline := time.Now().Add(3 * time.Second)
	buf := make([]byte, 1500)
	for time.Now().Before(deadline) {
		n, _, err := unix.Recvfrom(fd, buf, 0)
		if err != nil {
			continue
		}
		pkt := buf[:n]
		if n < 20 {
			continue
		}
		ihl := int(pkt[0]&0x0f) * 4
		if n < ihl+14 || [4]byte(pkt[12:16]) != dst {
			continue
		}
		t := pkt[ihl:]
		if int(binary.BigEndian.Uint16(t[0:])) != dport || int(binary.BigEndian.Uint16(t[2:])) != sport {
			continue
		}
		switch flags := t[13]; {
		case flags&0x04 != 0:
			return "rst", nil
		case flags&0x12 == 0x12:
			return "synack", nil
		}
	}
	return "none", nil
}

// vsock tries to reach a host port over AF_VSOCK. Docker's default seccomp
// profile refuses the socket; that is the backstop for the relay's vsock
// port, which the host listens on for the guest.
func vsock(cid, port uint32) string {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return errnoName(err)
	}
	defer unix.Close(fd)
	if err := unix.Connect(fd, &unix.SockaddrVM{CID: cid, Port: port}); err != nil {
		return errnoName(err)
	}
	return "connected"
}

func listen(port string) error {
	l, err := net.Listen("tcp4", "0.0.0.0:"+port)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, "listening")
	for {
		c, err := l.Accept()
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stdout, "accepted %s\n", c.RemoteAddr())
		c.Close()
	}
}
