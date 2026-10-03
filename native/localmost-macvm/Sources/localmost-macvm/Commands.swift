// The commands that touch an image or run a VM: install, provision,
// save-state, run and check. Each checks everything before it builds
// anything, takes its slot before it starts a VM, and ends with one `end`
// event; any failure before the VM starts ends it at once.

import AppKit
import Foundation
import MacVMCore
import Virtualization

/// The provisioning boot's size: macOS's Setup Assistant, softwareupdate
/// and the bootstrap need no more.
let provisionCpus = 4
let provisionMemoryBytes: UInt64 = 6 << 30

// MARK: - install

func runInstall(_ args: InstallArgs, _ ph: ProcessHooks) -> Never {
    let imageDir: String
    let layout: Layout
    do {
        try checkParent(getppid())
        (layout, imageDir) = try Layout.forImage(dataDir: args.dataDir, imageId: args.imageId)
        // The restore image, by the real <data> and no link: parseCommand
        // already held it to <data>/macos-vm/ipsw/<name>.ipsw.
        let ipswDir = layout.root + "/ipsw"
        let name = (args.ipsw as NSString).lastPathComponent
        do {
            let dir = try RealDirectory(ipswDir)
            defer { dir.close() }
            guard dir.path == ipswDir else {
                throw HelperError(.ipsw, "\(ipswDir) resolves to \(dir.path)")
            }
            guard case .regular = entry(in: dir.fd, name) else {
                throw HelperError(.ipsw, "\(ipswDir)/\(name) is missing, a link, or not a regular file")
            }
        } catch let e as POSIXError {
            throw HelperError(.ipsw, "\(ipswDir) cannot be opened: \(e.message)")
        }
        let ipswReal = ipswDir + "/" + name
        let slot = try SlotLock(layout: layout, slot: args.slot)
        ph.cleanup.append { slot.release() }
        var real = args
        real.ipsw = ipswReal
        let install = ImageInstall(args: real, imageDir: imageDir, layer: VZInstallLayer(), hooks: ph.hooks)
        let target = InstallTarget(install)
        ph.onOutputBroken = { target.parentGone() }
        let kept = watch(target, ppid: getppid())
        install.begin()
        runMain(keeping: kept)
    } catch let e as HelperError {
        failEarly(e)
    } catch {
        failEarly(HelperError(.install, describe(error)))
    }
}

private final class InstallTarget: Stoppable {
    let install: ImageInstall
    init(_ install: ImageInstall) { self.install = install }
    func parentGone() { install.stop("the parent process exited") }
    func inputClosed() { install.stop("stdin closed") }
    func signalled(_ name: String) { install.stop(name) }
    func command(_ item: LineReader.Item) {
        // `stop` is the one command an install takes; anything else is ignored.
        if case .line(let data) = item, let object = decodeLine(data), object["op"] as? String == "stop" {
            install.stop("stop")
        }
    }
}

// MARK: - Shared by the VM commands

/// The controller and what keeps it running.
private final class VMTarget: Stoppable {
    let controller: Controller
    /// Commands the controller does not know, offered first; true when taken.
    var extraCommand: (([String: Any]) -> Bool)?

    init(_ controller: Controller) { self.controller = controller }
    func parentGone() { controller.parentGone() }
    func inputClosed() { controller.inputClosed() }
    func signalled(_ name: String) { controller.signalled(name) }
    func command(_ item: LineReader.Item) {
        if case .line(let data) = item, let object = decodeLine(data), let extra = extraCommand, extra(object) {
            return
        }
        controller.handle(item)
    }
}

/// Removes a slot's saved state and the disks it was saved over, stamp
/// first so that nothing half-removed ever reads as whole. A boot of the
/// golden disk makes every slot's state stale, since each was cloned from it.
private func discardSlotState(_ slotDir: String) {
    guard let dir = try? RealDirectory(slotDir) else { return }
    defer { dir.close() }
    guard dir.path == slotDir else { return }
    for name in [SlotFile.stateStamp, SlotFile.state, SlotFile.state + ".tmp", SlotFile.disk, SlotFile.aux] {
        unlinkat(dir.fd, name, 0)
    }
}

private func requireSize(cpus: Int, memoryMiB: Int, _ config: ImageConfig) throws {
    guard cpus >= config.minCpus else {
        throw HelperError(.args, "macOS \(config.os) needs at least \(config.minCpus) CPUs")
    }
    guard UInt64(memoryMiB) << 20 >= config.minMemoryBytes else {
        throw HelperError(.args, "macOS \(config.os) needs at least \(config.minMemoryBytes >> 20) MiB")
    }
}

// MARK: - provision

func runProvision(_ args: ProvisionArgs, _ ph: ProcessHooks) -> Never {
    do {
        try checkParent(getppid())
        let (layout, imageDir) = try Layout.forImage(dataDir: args.dataDir, imageId: args.imageId)
        let image = try checkImage(imageDir, imageId: args.imageId)
        if args.display == .none, !provisioningCompiledIn {
            throw HelperError(.unsupported, "this helper was built without the macOS 27 SDK's guest provisioning")
        }
        if args.display == .none, !hostSupportsProvisioning() {
            throw HelperError(.unsupported, "headless provisioning needs macOS 27 or later on this Mac; use the guided setup")
        }
        let slot = try SlotLock(layout: layout, slot: args.slot)
        ph.cleanup.append { slot.release() }
        macVMSlots.forEach { discardSlotState(image.slotDir($0)) }
        guard let model = image.config.hardwareModelData, let identifier = image.config.machineIdentifierData(slot: args.slot) else {
            throw HelperError(.image, "config.json has no hardware model or machine identifier")
        }
        let configuration = try makeConfiguration(MacSpec(
            purpose: .provision(macAddress: image.config.macAddress), hardwareModel: model, machineIdentifier: identifier,
            aux: image.aux, disk: image.disk, cpus: max(provisionCpus, image.config.minCpus),
            memoryBytes: max(provisionMemoryBytes, image.config.minMemoryBytes)
        ))
        try validate(configuration)

        switch args.display {
        case .none:
            provisionHeadless(configuration, image: image, ph)
        case .window:
            provisionGuided(configuration, image: image, ph)
        }
    } catch let e as HelperError {
        failEarly(e)
    } catch {
        failEarly(HelperError(.vzConfig, describe(error)))
    }
}

/// macOS 27's guest provisioning: the VM starts once Electron sends the
/// account to create, on stdin - never on the command line, which any
/// process of the user can read.
private func provisionHeadless(_ configuration: VZVirtualMachineConfiguration, image: CheckedImage, _ ph: ProcessHooks) -> Never {
    var machine: MacMachine?
    var controller: Controller?
    let pending = PendingTarget()
    pending.onCredentials = { object in
        guard controller == nil else { return false }
        let account: ProvisioningAccount
        let options: VZMacOSVirtualMachineStartOptions
        do {
            account = try ProvisioningAccount(object)
            options = try provisioningStartOptions(account)
        } catch let e as HelperError {
            failEarly(e)
        } catch {
            failEarly(HelperError(.unsupported, describe(error)))
        }
        let m = MacMachine(configuration: configuration, relays: [:], startOptions: options, log: logLine)
        let c = Controller(machine: m, hooks: ph.controllerHooks)
        machine = m
        controller = c
        pending.controller = c
        c.begin(.cold, startedFields: ["mac": image.config.macAddress])
        return true
    }
    ph.onOutputBroken = { pending.parentGone() }
    let kept = watch(pending, ppid: getppid())
    ph.hooks.send(["event": "ready"])
    runMain(keeping: kept)
}

/// Stdin before and after the VM exists: the account first, then the
/// controller's commands. A stop before the account ends the command.
private final class PendingTarget: Stoppable {
    var controller: Controller?
    var onCredentials: (([String: Any]) -> Bool)?
    private var ended = false

    private func endEarly(_ why: String) {
        guard controller == nil, !ended else { return }
        ended = true
        logLine("info", "\(why) before provisioning began")
        let hooks = Hooks(emit: { writeAll(1, $0) }, log: logLine, finish: { exit($0) })
        hooks.end(nil, reason: "requested")
    }

    func parentGone() { controller?.parentGone() ?? endEarly("the parent process exited") }
    func inputClosed() { controller?.inputClosed() ?? endEarly("stdin closed") }
    func signalled(_ name: String) { controller?.signalled(name) ?? endEarly(name) }
    func command(_ item: LineReader.Item) {
        if case .line(let data) = item, let object = decodeLine(data), object["op"] as? String == "provision",
           let take = onCredentials, take(object)
        {
            return
        }
        if let controller = controller {
            controller.handle(item)
        } else if case .line(let data) = item, let object = decodeLine(data), object["op"] as? String == "stop" {
            endEarly("stop")
        }
    }
}

/// The guided setup: the VM in a window, beside the values to enter.
private func provisionGuided(_ configuration: VZVirtualMachineConfiguration, image: CheckedImage, _ ph: ProcessHooks) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let machine = MacMachine(configuration: configuration, relays: [:], log: logLine)
    let controller = Controller(machine: machine, hooks: ph.controllerHooks)
    let target = VMTarget(controller)
    var window: GuidedSetupWindow?
    target.extraCommand = { object in
        // The account Electron chose, to show beside the VM.
        guard object["op"] as? String == "guide", let account = try? ProvisioningAccount(object) else { return false }
        window?.show(account: account)
        return true
    }
    ph.onOutputBroken = { target.parentGone() }
    let kept = watch(target, ppid: getppid())
    window = GuidedSetupWindow(machine: machine.virtualMachine, onClose: { target.signalled("the window was closed") })
    controller.begin(.cold, startedFields: ["mac": image.config.macAddress])
    retained.append(kept)
    retained.append(window as Any)
    app.activate(ignoringOtherApps: true)
    app.run()
    exit(cleanExitCode)
}

// MARK: - save-state

/// Saves one slot's state: clones the golden disk and aux storage into the
/// slot's directory, boots the clone cold with the slot's identity and no
/// network, waits for the agent's ready hello, pauses and saves. The golden
/// disk itself is never booted here, so each slot's state goes with a disk
/// of its own and a save in one slot never invalidates the other's.
func runSaveState(_ args: SaveStateArgs, _ ph: ProcessHooks) -> Never {
    do {
        try checkParent(getppid())
        let (layout, imageDir) = try Layout.forImage(dataDir: args.dataDir, imageId: args.imageId)
        let image = try checkImage(imageDir, imageId: args.imageId)
        try requireSize(cpus: args.cpus, memoryMiB: args.memoryMiB, image.config)
        let slot = try SlotLock(layout: layout, slot: args.slot)
        ph.cleanup.append { slot.release() }
        let slotDir = image.slotDir(args.slot)
        discardSlotState(slotDir)
        let clone = try cloneDisks(from: image.dir, diskBytes: image.config.diskBytes, into: slotDir)
        // Until the stamp is written, what is in the slot is not a state:
        // any way out before then removes it.
        var saved = false
        ph.cleanup.append { if !saved { discardSlotState(slotDir) } }
        guard let model = image.config.hardwareModelData, let identifier = image.config.machineIdentifierData(slot: args.slot) else {
            throw HelperError(.image, "config.json has no hardware model or machine identifier")
        }
        let configuration = try makeConfiguration(MacSpec(
            purpose: .saveState, hardwareModel: model, machineIdentifier: identifier, aux: clone.aux, disk: clone.disk,
            cpus: args.cpus, memoryBytes: UInt64(args.memoryMiB) << 20
        ))
        try validate(configuration)
        if let why = saveRestoreRefusal(configuration) {
            throw HelperError(.state, "VZ cannot save this VM's state: \(why)")
        }
        let machine = MacMachine(configuration: configuration, relays: [:], log: logLine)
        let controller = Controller(machine: machine, hooks: ph.controllerHooks)
        let target = VMTarget(controller)
        ph.onOutputBroken = { target.parentGone() }
        let kept = watch(target, ppid: getppid())
        let stamp = StateStamp(slot: args.slot, hostBuild: hostOSBuild(), helperVersion: helperVersion, cpus: args.cpus,
                               memoryMiB: args.memoryMiB)
        let tmp = slotDir + "/" + SlotFile.state + ".tmp"
        let deadline = Date().addingTimeInterval(Double(agentReadyTimeoutMs) / 1000)

        func poll() {
            machine.helloFromAgent { line in
                if let line = line, isReadyHello(line) {
                    ph.hooks.send(["event": "agentReady"])
                    controller.saveAndStop(to: tmp) {
                        let dir = try RealDirectory(slotDir)
                        defer { dir.close() }
                        guard dir.path == slotDir else {
                            throw HelperError(.state, "the slot directory resolves to \(dir.path)")
                        }
                        guard renameat(dir.fd, SlotFile.state + ".tmp", dir.fd, SlotFile.state) == 0 else {
                            throw HelperError(.state, "the saved state cannot be put in place: \(posixMessage())")
                        }
                        let encoder = JSONEncoder()
                        encoder.outputFormatting = [.sortedKeys]
                        try writeFileAtomically(in: dir.fd, SlotFile.stateStamp, try encoder.encode(stamp))
                        saved = true
                    }
                    return
                }
                guard Date() < deadline else {
                    return controller.fail(HelperError(.state, "the guest agent was not ready within \(agentReadyTimeoutMs / 60000) minutes"))
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(agentPollMs)) { poll() }
            }
        }
        controller.begin(.cold, onRunning: {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(agentPollMs)) { poll() }
        })
        runMain(keeping: kept)
    } catch let e as HelperError {
        failEarly(e)
    } catch {
        failEarly(HelperError(.vzConfig, describe(error)))
    }
}

// MARK: - run

func runJob(_ args: RunArgs, _ ph: ProcessHooks) -> Never {
    raiseFileLimit()
    do {
        try checkParent(getppid())
        let (layout, vmDir) = try Layout.forVM(dataDir: args.dataDir, vmId: args.vmId)
        let image = try checkImage(layout.image(args.imageId), imageId: args.imageId)
        try requireSize(cpus: args.cpus, memoryMiB: args.memoryMiB, image.config)
        let slot = try SlotLock(layout: layout, slot: args.slot)
        ph.cleanup.append { slot.release() }
        try writePidFile(vmDir + "/" + VMFile.pidFile)
        let start = jobStart(image, slot: args.slot, boot: args.boot, hostBuild: hostOSBuild(), helperVersion: helperVersion,
                             cpus: args.cpus, memoryMiB: args.memoryMiB)
        let clone = try cloneDisks(from: start.sourceDir, diskBytes: image.config.diskBytes, into: vmDir)
        ph.cleanup.append { removeClone(in: vmDir) }
        guard let model = image.config.hardwareModelData else {
            throw HelperError(.image, "config.json has no hardware model")
        }
        let configuration = try makeConfiguration(MacSpec(
            purpose: .job, hardwareModel: model, machineIdentifier: start.machineIdentifier,
            aux: clone.aux, disk: clone.disk, cpus: args.cpus, memoryBytes: UInt64(args.memoryMiB) << 20
        ))
        try validate(configuration)

        var plan = start.plan
        var refusal = start.restoreSkipped
        if case .restore = plan, let why = saveRestoreRefusal(configuration) {
            // The slot's disk is already cloned; booted cold it recovers as
            // after a power cut, which costs a slower boot, never the job.
            plan = .cold
            refusal = why
        }
        let machine = MacMachine(configuration: configuration,
                                 relays: [GuestPort.proxy: args.proxyPort, GuestPort.broker: args.brokerPort], log: logLine)
        let controller = Controller(machine: machine, hooks: ph.controllerHooks)
        let target = VMTarget(controller)
        ph.onOutputBroken = { target.parentGone() }
        let socket = vmDir + "/" + VMFile.agentSocket
        let listener = try UnixListener(path: socket, maxConnections: maxConnectionsPerSocket) { conn in
            machine.dialAgent(for: conn)
        }
        ph.cleanup.append { listener.close() }
        let kept = watch(target, ppid: getppid())
        ph.hooks.send(["event": "listening", "agentSocket": socket])
        var fields: [String: Any] = [:]
        if let refusal = refusal { fields["restoreSkipped"] = bounded(refusal) }
        controller.begin(plan, startedFields: fields)
        runMain(keeping: kept, listener)
    } catch let e as HelperError {
        failEarly(e)
    } catch {
        failEarly(HelperError(.vzConfig, describe(error)))
    }
}

// MARK: - check

func runCheck(_ args: CheckArgs, _ hooks: Hooks) -> Never {
    do {
        let (_, imageDir) = try Layout.forImage(dataDir: args.dataDir, imageId: args.imageId)
        let image = try checkImage(imageDir, imageId: args.imageId)
        guard let data = image.config.hardwareModelData, let model = VZMacHardwareModel(dataRepresentation: data) else {
            throw HelperError(.image, "the image's hardware model cannot be read")
        }
        var states: [String: Any] = [:]
        for (slot, state) in image.states {
            states[String(slot)] = [
                "hostBuild": state.stamp.hostBuild, "cpus": state.stamp.cpus, "memoryMiB": state.stamp.memoryMiB,
                "helperVersion": state.stamp.helperVersion,
                "stateBytes": NSNumber(value: allocatedBytes(state.state)),
            ] as [String: Any]
        }
        hooks.end(nil, reason: "done", extra: [
            "build": image.config.build, "os": image.config.os,
            "supported": model.isSupported,
            "diskBytes": NSNumber(value: image.config.diskBytes),
            "diskAllocatedBytes": NSNumber(value: allocatedBytes(image.disk)),
            "states": states,
        ])
    } catch let e as HelperError {
        hooks.end(e, reason: "error")
    } catch {
        hooks.end(HelperError(.image, describe(error)), reason: "error")
    }
    exit(cleanExitCode)
}

/// The bytes a sparse file holds on disk.
func allocatedBytes(_ path: String) -> Int64 {
    var st = stat()
    guard lstat(path, &st) == 0 else { return 0 }
    return Int64(st.st_blocks) * 512
}
