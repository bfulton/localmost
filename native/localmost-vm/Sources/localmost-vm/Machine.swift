// The real VM behind the Machine protocol, and its sockets (contract §2.3):
// each unix connection is dialled to its guest port, and each guest
// connection to vsock 3128 is relayed to 127.0.0.1:<proxy-port>.
//
// VZ runs on the main queue. Nothing here blocks it: the vsock listener's
// delegate only counts and returns, every copy happens on another queue,
// and no connect holds a thread while it waits. (The spike's first listener
// deadlocked by reading inside shouldAcceptNewConnection.)

import Foundation
import Virtualization

/// Guest vsock ports (contract §3.1).
enum GuestPort {
    static let agent: UInt32 = 1025
    static let docker: UInt32 = 2375
    /// The one host-side listener: the guest's proxy relay.
    static let relay: UInt32 = 3128
}

/// The most relay connections at once (§2.3).
let maxRelayConnections = 256

/// How long a relay waits for the proxy to take its connection. The proxy is
/// on loopback, so a connect that takes this long is not going to finish.
let relayDialTimeoutMs = 5000

final class VZMachine: NSObject, Machine, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate {
    var onStop: ((MachineStopCause) -> Void)?

    private let vm: VZVirtualMachine
    private let proxyPort: Int?
    private let log: (String, String) -> Void
    private var running = false
    private var relayListener: VZVirtioSocketListener?
    private let relayLock = NSLock()
    private var relays = 0
    /// Where the relay dials finish. Nothing on it blocks.
    private let dialQueue = DispatchQueue(label: "localmost-vm relay dial")

    /// `proxyPort` is the worker's proxy in job mode, and nil in refresh
    /// mode, which listens on no vsock port at all.
    init(configuration: VZVirtualMachineConfiguration, proxyPort: Int?, log: @escaping (String, String) -> Void) {
        vm = VZVirtualMachine(configuration: configuration)
        self.proxyPort = proxyPort
        self.log = log
        super.init()
        vm.delegate = self
    }

    private var socketDevice: VZVirtioSocketDevice? {
        vm.socketDevices.first as? VZVirtioSocketDevice
    }

    // MARK: - Machine

    func start(_ done: @escaping (Error?) -> Void) {
        vm.start { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success:
                self.running = true
                self.listenForRelay()
                done(nil)
            case .failure(let error):
                done(error)
            }
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

    // MARK: - Unix socket to guest port

    /// Dials a guest port for an accepted unix connection, and copies bytes
    /// both ways until either side closes. A failed dial closes the
    /// connection at once. Callable from any queue.
    func dial(_ port: UInt32, for conn: UnixListener.Connection) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.running, let device = self.socketDevice else {
                return conn.release()
            }
            device.connect(toPort: port) { result in
                switch result {
                case .success(let vsock):
                    let relay = Relay(Relay.End(fd: conn.fd, close: conn.release),
                                      Relay.End(fd: vsock.fileDescriptor, close: { DispatchQueue.main.async { vsock.close() } }),
                                      label: "port \(port)")
                    relay.start()
                case .failure:
                    conn.release()
                }
            }
        }
    }

    // MARK: - vsock 3128 to the proxy

    private func listenForRelay() {
        guard proxyPort != nil, let device = socketDevice else { return }
        let listener = VZVirtioSocketListener()
        listener.delegate = self
        device.setSocketListener(listener, forPort: GuestPort.relay)
        relayListener = listener
    }

    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                  from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard let port = proxyPort, connection.destinationPort == GuestPort.relay, takeRelaySlot() else {
            return false
        }
        let vsockEnd = Relay.End(fd: connection.fileDescriptor, close: { DispatchQueue.main.async { connection.close() } })
        dialLoopback(port: port, queue: dialQueue, timeoutMs: relayDialTimeoutMs) { [weak self] result in
            switch result {
            case .success(let tcp):
                let relay = Relay(vsockEnd, Relay.End(fd: tcp, close: {
                    Darwin.close(tcp)
                    self?.releaseRelaySlot()
                }), label: "relay")
                relay.start()
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
        guard relays < maxRelayConnections else { return false }
        relays += 1
        return true
    }

    private func releaseRelaySlot() {
        relayLock.lock()
        relays -= 1
        relayLock.unlock()
    }
}
