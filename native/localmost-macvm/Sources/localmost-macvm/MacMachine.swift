// The real VM behind MacVMCore's Machine protocol, and its vsock: the guest
// agent's port, which agent.sock is dialled to, and the two host-side ports
// the guest dials, each relayed to one loopback port of the host - the job's
// proxy and the broker - and nowhere else.
//
// VZ runs on the main queue. Nothing here blocks it: the vsock listener's
// delegate only counts and returns, every copy happens on another queue,
// and no connect holds a thread while it waits.

import Foundation
import MacVMCore
import Virtualization

/// vsock ports, the same numbers the guest agent uses (MacVMAgentCore.AgentPorts).
enum GuestPort {
    /// The guest agent's control port, which the host dials.
    static let agent: UInt32 = 1025
    /// Host-side: the guest's way to the job's proxy.
    static let proxy: UInt32 = 3128
    /// Host-side: the guest's way to the broker.
    static let broker: UInt32 = 8787
}

/// The most relay connections at once, both host-side ports together.
let maxRelayConnections = 256

/// How long a relay waits for the proxy or broker to take its connection.
let relayDialTimeoutMs = 5000

final class MacMachine: NSObject, Machine, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate {
    var onStop: ((MachineStopCause) -> Void)?

    private let configuration: VZVirtualMachineConfiguration
    private var vm: VZVirtualMachine
    /// Host-side vsock port -> loopback port, for a job VM; empty otherwise.
    private let relays: [UInt32: Int]
    private let startOptions: VZMacOSVirtualMachineStartOptions?
    private let log: (String, String) -> Void
    private var running = false
    private var listener: VZVirtioSocketListener?
    private let relayLock = NSLock()
    private var relayCount = 0
    private let dialQueue = DispatchQueue(label: "localmost-macvm relay dial")

    init(configuration: VZVirtualMachineConfiguration, relays: [UInt32: Int], startOptions: VZMacOSVirtualMachineStartOptions? = nil,
         log: @escaping (String, String) -> Void) {
        self.configuration = configuration
        vm = VZVirtualMachine(configuration: configuration)
        self.relays = relays
        self.startOptions = startOptions
        self.log = log
        super.init()
        vm.delegate = self
    }

    /// The VM, for the guided setup's window.
    var virtualMachine: VZVirtualMachine { vm }

    private var socketDevice: VZVirtioSocketDevice? {
        vm.socketDevices.first as? VZVirtioSocketDevice
    }

    // MARK: - Machine

    func start(_ done: @escaping (Error?) -> Void) {
        if vm.state != .stopped {
            // A refused restore can leave the VM in an error state; a cold
            // boot gets a VM of its own.
            vm = VZVirtualMachine(configuration: configuration)
            vm.delegate = self
        }
        let finished: (Error?) -> Void = { [weak self] error in
            guard let self = self else { return }
            if error == nil {
                self.running = true
                self.listenForRelays()
            }
            done(error)
        }
        if let options = startOptions {
            vm.start(options: options, completionHandler: finished)
        } else {
            vm.start { result in
                switch result {
                case .success: finished(nil)
                case .failure(let error): finished(error)
                }
            }
        }
    }

    func restore(from path: String, _ done: @escaping (Error?) -> Void) {
        vm.restoreMachineStateFrom(url: URL(fileURLWithPath: path)) { [weak self] error in
            guard let self = self else { return }
            if let error = error {
                return done(error)
            }
            self.vm.resume { result in
                switch result {
                case .success:
                    self.running = true
                    self.listenForRelays()
                    done(nil)
                case .failure(let error):
                    done(error)
                }
            }
        }
    }

    func pauseAndSave(to path: String, _ done: @escaping (Error?) -> Void) {
        vm.pause { [weak self] result in
            guard let self = self else { return }
            if case .failure(let error) = result {
                return done(error)
            }
            self.vm.saveMachineStateTo(url: URL(fileURLWithPath: path)) { error in done(error) }
        }
    }

    func requestStop() -> Bool {
        guard vm.canRequestStop else { return false }
        do {
            try vm.requestStop()
            return true
        } catch {
            log("warn", "the guest could not be asked to stop: \(describe(error))")
            return false
        }
    }

    func forceStop(_ done: @escaping (Error?) -> Void) {
        running = false
        guard vm.canStop else { return done(nil) }
        vm.stop { error in done(error) }
    }

    // MARK: - VZVirtualMachineDelegate

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        running = false
        onStop?(.guest)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        running = false
        onStop?(.error(describe(error)))
    }

    // MARK: - agent.sock to the guest agent

    /// Dials the guest agent for an accepted unix connection, and copies
    /// bytes both ways until either side closes. Callable from any queue.
    func dialAgent(for conn: UnixListener.Connection) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.running, let device = self.socketDevice else {
                return conn.release()
            }
            device.connect(toPort: GuestPort.agent) { result in
                switch result {
                case .success(let vsock):
                    Relay(Relay.End(fd: conn.fd, close: conn.release),
                          Relay.End(fd: vsock.fileDescriptor, close: { DispatchQueue.main.async { vsock.close() } }),
                          label: "agent").start()
                case .failure:
                    conn.release()
                }
            }
        }
    }

    /// Connects to the guest agent and reads its first line, for save-state:
    /// the agent greets every connection with a hello saying whether it is
    /// ready. `done` gets the line, or nil when nothing answered.
    func helloFromAgent(_ done: @escaping (Data?) -> Void) {
        guard running, let device = socketDevice else { return done(nil) }
        device.connect(toPort: GuestPort.agent) { result in
            guard case .success(let vsock) = result else { return done(nil) }
            let fd = vsock.fileDescriptor
            DispatchQueue.global().async {
                var reader = LineReader()
                var buf = [UInt8](repeating: 0, count: 4096)
                var line: Data?
                var tv = timeval(tv_sec: 10, tv_usec: 0)
                _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
                while line == nil {
                    let n = read(fd, &buf, buf.count)
                    if n < 0, errno == EINTR { continue }
                    if n <= 0 { break }
                    for item in reader.feed(Data(buf[0..<n])) {
                        if case .line(let l) = item, line == nil { line = l }
                    }
                    if reader.buffered >= maxLineBytes { break }
                }
                DispatchQueue.main.async {
                    vsock.close()
                    done(line)
                }
            }
        }
    }

    // MARK: - Host-side vsock ports to loopback

    private func listenForRelays() {
        guard !relays.isEmpty, let device = socketDevice else { return }
        let listener = VZVirtioSocketListener()
        listener.delegate = self
        for port in relays.keys {
            device.setSocketListener(listener, forPort: port)
        }
        self.listener = listener
    }

    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                  from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard let port = relays[connection.destinationPort], takeRelaySlot() else {
            return false
        }
        let vsockEnd = Relay.End(fd: connection.fileDescriptor, close: { DispatchQueue.main.async { connection.close() } })
        dialLoopback(port: port, queue: dialQueue, timeoutMs: relayDialTimeoutMs) { [weak self] result in
            switch result {
            case .success(let tcp):
                Relay(vsockEnd, Relay.End(fd: tcp, close: {
                    Darwin.close(tcp)
                    self?.releaseRelaySlot()
                }), label: "relay \(port)").start()
            case .failure(let error):
                self?.log("warn", "relay to 127.0.0.1:\(port) failed: \(describe(error))")
                vsockEnd.close()
                self?.releaseRelaySlot()
            }
        }
        return true
    }

    private func takeRelaySlot() -> Bool {
        relayLock.lock()
        defer { relayLock.unlock() }
        guard relayCount < maxRelayConnections else { return false }
        relayCount += 1
        return true
    }

    private func releaseRelaySlot() {
        relayLock.lock()
        relayCount -= 1
        relayLock.unlock()
    }
}
