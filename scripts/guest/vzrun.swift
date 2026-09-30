// vzrun: boots a Linux guest with Virtualization.framework. The guest image
// build uses it for the build VM and the smoke boot (contract §4.3 steps 6
// and 7), and it is the development harness for the guest. It is not the
// product's helper (native/localmost-vm): it takes paths, trusts its caller,
// and is never shipped.
//
//   vzrun --kernel <Image> --initrd <cpio.gz> [--cmdline <s>]
//         [--cpus <n>] [--memory-mib <n>] [--console <file>] [--timeout <sec>]
//         [--share <tag>=<path>:ro|rw]...
//         [--disk <path>:ro|rw:none|fsync|full]...        (vda, vdb, ... in order)
//         [--vsock-unix <port>:<path>[:to-guest|from-guest]]...
//         [--rosetta]
//
// --vsock-unix to-guest (the default) binds <path> and dials guest <port> for
// each connection, as the helper exposes docker.sock and agent.sock.
// from-guest listens on vsock <port> and connects each guest connection to
// the unix socket at <path>, as the helper's proxy relay does.
//
// Events go to stdout as JSON lines: {"event":"listening"}, {"event":"started",
// "rosetta":...,"ms":...}, {"event":"stopped","reason":...}. Logs go to stderr.
// The VM stops when stdin reaches EOF, on SIGTERM or SIGINT, or at --timeout.
// Exit status: 0 when the guest stopped itself, 1 on a VZ error, 2 on bad
// arguments, 3 at the timeout, 4 when stopped by a signal or stdin EOF.

import Foundation
import Virtualization

let t0 = Date()
func ms() -> Int { Int(Date().timeIntervalSince(t0) * 1000) }
func log(_ s: String) { FileHandle.standardError.write("vzrun: \(s)\n".data(using: .utf8)!) }
func event(_ fields: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + "\n".data(using: .utf8)!)
}
func die(_ s: String, _ code: Int32 = 2) -> Never { log(s); exit(code) }

// ---- arguments ---------------------------------------------------------------

struct VsockUnix { let port: UInt32; let path: String; let toGuest: Bool }

var kernel = "", initrd = "", cmdline = "console=hvc0 rdinit=/init quiet"
var cpus = 2, memoryMiB = 2048, timeoutSec = 0.0, console: String?
var shares: [(tag: String, path: String, ro: Bool)] = []
var disks: [(path: String, ro: Bool, sync: VZDiskImageSynchronizationMode)] = []
var vsocks: [VsockUnix] = []
var wantRosetta = false

var args = Array(CommandLine.arguments.dropFirst())
func next(_ flag: String) -> String {
    guard !args.isEmpty else { die("\(flag) needs a value") }
    return args.removeFirst()
}
while !args.isEmpty {
    let flag = args.removeFirst()
    switch flag {
    case "--kernel": kernel = next(flag)
    case "--initrd": initrd = next(flag)
    case "--cmdline": cmdline = next(flag)
    case "--cpus": cpus = Int(next(flag)) ?? 0
    case "--memory-mib": memoryMiB = Int(next(flag)) ?? 0
    case "--console": console = next(flag)
    case "--timeout": timeoutSec = Double(next(flag)) ?? 0
    case "--rosetta": wantRosetta = true
    case "--share":
        let v = next(flag)
        guard let eq = v.firstIndex(of: "="), let colon = v.lastIndex(of: ":"), colon > eq else { die("bad --share \(v)") }
        let mode = String(v[v.index(after: colon)...])
        guard mode == "ro" || mode == "rw" else { die("bad --share mode \(mode)") }
        shares.append((String(v[..<eq]), String(v[v.index(after: eq)..<colon]), mode == "ro"))
    case "--disk":
        let parts = next(flag).split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, ["ro", "rw"].contains(parts[1]) else { die("bad --disk") }
        let sync: VZDiskImageSynchronizationMode
        switch parts[2] {
        case "none": sync = .none
        case "fsync": sync = .fsync
        case "full": sync = .full
        default: die("bad --disk sync mode \(parts[2])")
        }
        disks.append((parts[0], parts[1] == "ro", sync))
    case "--vsock-unix":
        let parts = next(flag).split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2 || parts.count == 3, let port = UInt32(parts[0]) else { die("bad --vsock-unix") }
        let dir = parts.count == 3 ? parts[2] : "to-guest"
        guard dir == "to-guest" || dir == "from-guest" else { die("bad --vsock-unix direction \(dir)") }
        vsocks.append(VsockUnix(port: port, path: parts[1], toGuest: dir == "to-guest"))
    default: die("unknown argument \(flag)")
    }
}
guard !kernel.isEmpty, !initrd.isEmpty, cpus >= 1, memoryMiB >= 256 else { die("--kernel and --initrd are required") }

// ---- configuration -------------------------------------------------------------

let cfg = VZVirtualMachineConfiguration()
let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernel))
boot.initialRamdiskURL = URL(fileURLWithPath: initrd)
boot.commandLine = cmdline
cfg.bootLoader = boot
cfg.cpuCount = cpus
cfg.memorySize = UInt64(memoryMiB) * 1024 * 1024
let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
let consoleHandle: FileHandle
if let console {
    FileManager.default.createFile(atPath: console, contents: nil)
    guard let h = FileHandle(forWritingAtPath: console) else { die("cannot open \(console)") }
    consoleHandle = h
} else {
    consoleHandle = FileHandle.standardError
}
serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: consoleHandle)
cfg.serialPorts = [serial]
cfg.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
var dirDevices: [VZDirectorySharingDeviceConfiguration] = []
for s in shares {
    let dev = VZVirtioFileSystemDeviceConfiguration(tag: s.tag)
    dev.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: s.path), readOnly: s.ro))
    dirDevices.append(dev)
}
var rosettaState = "off"
if wantRosetta {
    switch VZLinuxRosettaDirectoryShare.availability {
    case .installed:
        rosettaState = "installed"
        let dev = VZVirtioFileSystemDeviceConfiguration(tag: "rosetta")
        dev.share = try! VZLinuxRosettaDirectoryShare()
        dirDevices.append(dev)
    case .notInstalled: rosettaState = "notInstalled"
    case .notSupported: rosettaState = "notSupported"
    @unknown default: rosettaState = "notSupported"
    }
}
cfg.directorySharingDevices = dirDevices
var storage: [VZStorageDeviceConfiguration] = []
for d in disks {
    do {
        let att = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: d.path), readOnly: d.ro, cachingMode: .automatic, synchronizationMode: d.sync)
        storage.append(VZVirtioBlockDeviceConfiguration(attachment: att))
    } catch { die("cannot attach \(d.path): \(error)", 1) }
}
cfg.storageDevices = storage
cfg.socketDevices = [VZVirtioSocketDeviceConfiguration()]
// No networkDevices: the guest has no NIC.
do { try cfg.validate() } catch { die("validate: \(error)", 1) }
let vm = VZVirtualMachine(configuration: cfg)

// ---- byte copying ----------------------------------------------------------------

/// Copies bytes both ways between two sockets on their own threads, half-closing
/// each direction at EOF, then calls `done`.
func splice(_ a: Int32, _ b: Int32, done: @escaping () -> Void) {
    let group = DispatchGroup()
    func pump(_ from: Int32, _ to: Int32) {
        group.enter()
        Thread.detachNewThread {
            var buf = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                let n = read(from, &buf, buf.count)
                if n <= 0 { break }
                var off = 0
                while off < n {
                    let w = buf.withUnsafeBytes { write(to, $0.baseAddress! + off, n - off) }
                    if w <= 0 { off = -1; break }
                    off += w
                }
                if off < 0 { break }
            }
            shutdown(to, SHUT_WR)
            group.leave()
        }
    }
    pump(a, b)
    pump(b, a)
    group.notify(queue: .global()) { done() }
}

func unixAddr(_ path: String) -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { die("socket path too long: \(path)") }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        for (i, b) in bytes.enumerated() { raw[i] = b }
    }
    return addr
}

func connectUnix(_ path: String) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = unixAddr(path)
    let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    if rc != 0 { close(fd); return -1 }
    return fd
}

let held = NSMutableSet() // connections kept alive while their bytes are copied
let heldLock = NSLock()
func hold(_ c: VZVirtioSocketConnection) { heldLock.lock(); held.add(c); heldLock.unlock() }
func releaseConn(_ c: VZVirtioSocketConnection) { heldLock.lock(); held.remove(c); heldLock.unlock(); c.close() }

// to-guest: a unix listener whose every connection is dialled to the guest port.
func serveToGuest(_ v: VsockUnix, device: VZVirtioSocketDevice) {
    unlink(v.path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = unixAddr(v.path)
    let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    guard rc == 0, chmod(v.path, 0o600) == 0, listen(fd, 64) == 0 else { die("cannot listen on \(v.path): \(errno)", 1) }
    Thread.detachNewThread {
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 { continue }
            DispatchQueue.main.async {
                device.connect(toPort: v.port) { result in
                    switch result {
                    case .success(let conn):
                        hold(conn)
                        splice(client, conn.fileDescriptor) { close(client); DispatchQueue.main.async { releaseConn(conn) } }
                    case .failure:
                        close(client)
                    }
                }
            }
        }
    }
}

// from-guest: every guest connection to the port is connected to the unix path.
final class FromGuest: NSObject, VZVirtioSocketListenerDelegate {
    let path: String
    init(path: String) { self.path = path }
    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection conn: VZVirtioSocketConnection, from device: VZVirtioSocketDevice) -> Bool {
        hold(conn)
        // Never block the VZ queue: dial and copy elsewhere.
        DispatchQueue.global().async {
            let fd = connectUnix(self.path)
            if fd < 0 { DispatchQueue.main.async { releaseConn(conn) }; return }
            splice(fd, conn.fileDescriptor) { close(fd); DispatchQueue.main.async { releaseConn(conn) } }
        }
        return true
    }
}
var fromGuest: [FromGuest] = []
var listeners: [VZVirtioSocketListener] = []

// ---- lifecycle ---------------------------------------------------------------------

final class Delegate: NSObject, VZVirtualMachineDelegate {
    func guestDidStop(_ vm: VZVirtualMachine) {
        log("guest stopped at \(ms()) ms")
        event(["event": "stopped", "reason": "guest", "ms": ms()])
        exit(0)
    }
    func virtualMachine(_ vm: VZVirtualMachine, didStopWithError error: Error) {
        log("stopped with error: \(error)")
        event(["event": "stopped", "reason": "error", "message": "\(error)"])
        exit(1)
    }
}
let delegate = Delegate()
vm.delegate = delegate

func forceStop(_ reason: String, _ code: Int32) {
    DispatchQueue.main.async {
        log("stopping: \(reason)")
        vm.stop { _ in
            event(["event": "stopped", "reason": reason])
            exit(code)
        }
    }
}

let device = vm.socketDevices.first as! VZVirtioSocketDevice
for v in vsocks where v.toGuest { serveToGuest(v, device: device) }
event(["event": "listening"])

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let sigs = [SIGTERM, SIGINT].map { s -> DispatchSourceSignal in
    let src = DispatchSource.makeSignalSource(signal: s, queue: .main)
    src.setEventHandler { forceStop("signal", 4) }
    src.resume()
    return src
}
Thread.detachNewThread {
    var b = [UInt8](repeating: 0, count: 512)
    while read(0, &b, b.count) > 0 {}
    forceStop("stdin", 4)
}
if timeoutSec > 0 {
    DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSec) { forceStop("timeout", 3) }
}

vm.start { result in
    switch result {
    case .success:
        for v in vsocks where !v.toGuest {
            let d = FromGuest(path: v.path)
            let l = VZVirtioSocketListener()
            l.delegate = d
            device.setSocketListener(l, forPort: v.port)
            fromGuest.append(d)
            listeners.append(l)
        }
        log("started at \(ms()) ms, pid \(getpid()), rosetta \(rosettaState)")
        event(["event": "started", "pid": Int(getpid()), "rosetta": rosettaState, "ms": ms()])
    case .failure(let error):
        die("start: \(error)", 1)
    }
}
RunLoop.main.run()
