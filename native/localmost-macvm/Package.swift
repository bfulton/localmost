// swift-tools-version:5.9
//
// localmost-macvm: the helper that builds localmost's golden macOS image and
// runs one macOS VM per job that asks for `isolation: macos-vm`, and the
// agent that runs inside that VM. See docs/roadmap/macos-vm-jobs.md.
//
// A sibling of native/localmost-vm, not a mode of it: that helper's contract
// is a Linux guest booted from artifacts in Resources, with a share and a
// docker socket. This one installs macOS from an IPSW, keeps a golden image
// and its saved state, opens a window for the guided setup, and ships a guest
// agent built from the same sources.
//
// `npm run build:macvm` builds both programs for release and copies them to
// build/; `swift test` here runs their unit tests.

import PackageDescription

let package = Package(
    name: "localmost-macvm",
    platforms: [.macOS(.v14)],
    targets: [
        // What the helper decides without Virtualization.framework: its
        // arguments, its paths, the golden image's files, clones, slots and
        // the install and run sequences, against an injected VZ layer.
        .target(
            name: "MacVMCore",
            path: "Sources/MacVMCore"
        ),
        .executableTarget(
            name: "localmost-macvm",
            dependencies: ["MacVMCore"],
            path: "Sources/localmost-macvm",
            linkerSettings: [.linkedFramework("Virtualization"), .linkedFramework("AppKit")]
        ),
        // The guest agent's protocol, job and relay logic, testable on the host.
        .target(
            name: "MacVMAgentCore",
            dependencies: ["MacVMCore"],
            path: "Sources/MacVMAgentCore"
        ),
        .executableTarget(
            name: "localmost-macvm-agent",
            dependencies: ["MacVMAgentCore"],
            path: "Sources/localmost-macvm-agent"
        ),
        .testTarget(
            name: "MacVMCoreTests",
            dependencies: ["MacVMCore"],
            path: "Tests/MacVMCoreTests"
        ),
        .testTarget(
            name: "MacVMAgentCoreTests",
            dependencies: ["MacVMAgentCore"],
            path: "Tests/MacVMAgentCoreTests"
        ),
    ]
)
