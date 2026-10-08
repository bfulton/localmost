// swift-tools-version:5.9
//
// localmost-vm: the helper that runs one Linux VM per Docker-using job
// through Virtualization.framework, under a seatbelt profile of its own.
// See docs/roadmap/vm-docker-backend-contract.md, section 2.
//
// `npm run build:helper` builds it for release and copies it to
// build/localmost-vm; `swift test` here runs its unit tests.

import PackageDescription

let package = Package(
    name: "localmost-vm",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "localmost-vm",
            path: "Sources/localmost-vm",
            linkerSettings: [.linkedFramework("Virtualization")]
        ),
        .testTarget(
            name: "localmost-vmTests",
            dependencies: ["localmost-vm"],
            path: "Tests/localmost-vmTests"
        ),
    ]
)
