// AF_VSOCK in a macOS guest (sys/vsock.h): the agent's listener on its
// control port, which takes connections only from the host, and its dials
// to the host's relay ports.

import Darwin
import Foundation
import MacVMAgentCore

/// sockaddr_vm, laid out as sys/vsock.h declares it.
struct SockaddrVM {
    var len: UInt8 = UInt8(MemoryLayout<SockaddrVM>.size)
    var family: sa_family_t = sa_family_t(AF_VSOCK)
    var reserved: UInt16 = 0
    var port: UInt32
    var cid: UInt32
}

let cidAny: UInt32 = 0xFFFF_FFFF

/// A listening vsock socket on `port`, any CID.
func vsockListen(port: UInt32) throws -> Int32 {
    let fd = socket(AF_VSOCK, SOCK_STREAM, 0)
    guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    var addr = SockaddrVM(port: port, cid: cidAny)
    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<SockaddrVM>.size)) }
    }
    guard rc == 0, listen(fd, 16) == 0 else {
        let e = errno
        close(fd)
        throw POSIXError(POSIXErrorCode(rawValue: e) ?? .EIO)
    }
    return fd
}

/// Accepts one connection; nil for a peer that is not the host, whose
/// connection is closed at once.
func vsockAcceptFromHost(_ listener: Int32) -> Int32? {
    var addr = SockaddrVM(port: 0, cid: 0)
    var len = socklen_t(MemoryLayout<SockaddrVM>.size)
    let fd = withUnsafeMutablePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { accept(listener, $0, &len) }
    }
    guard fd >= 0 else { return nil }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    guard addr.cid == hostCID else {
        close(fd)
        return nil
    }
    return fd
}

/// Dials the host's vsock `port`.
func vsockConnectHost(port: UInt32) throws -> Int32 {
    let fd = socket(AF_VSOCK, SOCK_STREAM, 0)
    guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    var addr = SockaddrVM(port: port, cid: hostCID)
    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<SockaddrVM>.size)) }
    }
    guard rc == 0 else {
        let e = errno
        close(fd)
        throw POSIXError(POSIXErrorCode(rawValue: e) ?? .EIO)
    }
    return fd
}

/// A TCP listener on 127.0.0.1:`port`.
func loopbackListen(port: Int) throws -> Int32 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    var on: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = in_addr_t(UInt32(0x7f00_0001).bigEndian)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard rc == 0, listen(fd, 64) == 0 else {
        let e = errno
        close(fd)
        throw POSIXError(POSIXErrorCode(rawValue: e) ?? .EIO)
    }
    return fd
}
