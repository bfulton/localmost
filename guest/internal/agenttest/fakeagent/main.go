// Command fakeagent serves the fake guest agent on a unix socket, for
// checking the helper's agent.sock splicing on the Mac without a VM:
//
//	go run ./internal/agenttest/fakeagent -unix /path/to/agent.sock
package main

import (
	"flag"
	"log"
	"net"
	"os"

	"github.com/bfulton/localmost/guest/internal/agenttest"
)

func main() {
	sock := flag.String("unix", "", "unix socket path to listen on")
	flag.Parse()
	if *sock == "" {
		log.Fatal("fakeagent: -unix is required")
	}
	os.Remove(*sock)
	l, err := net.Listen("unix", *sock)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("fakeagent: serving on %s", *sock)
	if err := agenttest.Serve(l, &agenttest.Fake{}); err != nil {
		log.Fatal(err)
	}
}
