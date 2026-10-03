// The guided setup's window: the provisioning VM's display, and beside it
// the steps to take in it and the values to enter. It is the only window the
// helper ever opens, and only for `provision --display window`, which
// Electron runs when the operator asks for the guided setup.

import AppKit
import MacVMCore
import Virtualization

final class GuidedSetupWindow: NSObject, NSWindowDelegate {
    private let window: NSWindow
    private let steps: NSTextView
    private let onClose: () -> Void
    private var closing = false

    init(machine: VZVirtualMachine, onClose: @escaping () -> Void) {
        self.onClose = onClose
        let view = VZVirtualMachineView()
        view.virtualMachine = machine
        view.capturesSystemKeys = true
        if #available(macOS 14, *) {
            view.automaticallyReconfiguresDisplay = false
        }

        steps = NSTextView()
        steps.isEditable = false
        steps.isSelectable = true
        steps.font = NSFont.systemFont(ofSize: 13)
        steps.textContainerInset = NSSize(width: 12, height: 12)
        steps.string = "Waiting for localmost to send the account to create..."
        let scroll = NSScrollView()
        scroll.documentView = steps
        scroll.hasVerticalScroller = true
        steps.autoresizingMask = [.width]
        steps.minSize = NSSize(width: 0, height: 0)
        steps.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        steps.isVerticallyResizable = true

        let split = NSSplitView()
        split.isVertical = true
        split.dividerStyle = .thin
        split.addArrangedSubview(view)
        split.addArrangedSubview(scroll)

        let width = CGFloat(displayWidth) / 2 + 320
        let height = CGFloat(displayHeight) / 2
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "localmost - macOS VM setup"
        window.contentView = split
        window.isReleasedWhenClosed = false
        super.init()
        window.delegate = self
        split.setPosition(width - 320, ofDividerAt: 0)
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    func show(account: ProvisioningAccount) {
        steps.string = guidedSetupSteps(account).enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n\n")
    }

    /// Closing the window stops the VM; the helper then ends.
    func windowWillClose(_ notification: Notification) {
        guard !closing else { return }
        closing = true
        onClose()
    }
}
