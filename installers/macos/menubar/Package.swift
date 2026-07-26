// swift-tools-version:5.9
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/menubar/Package.swift
//
// Pure Swift Package Manager executable — deliberately NO Xcode project,
// buildable end-to-end with `swift build` / `swift test` from the CLI
// (lane brief requirement). NO SwiftUI: LoombreMenubar is plain AppKit
// (NSStatusItem/NSMenu), matching the "menubar controller, NO SwiftUI"
// instruction literally. Zero external SPM dependencies — Foundation +
// AppKit only, so there is nothing here for a lockfile/license gate to
// even see.

import PackageDescription

let package = Package(
    name: "LoombreMenubar",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        // Testable client-side implementation of @loombre/controller-ipc
        // (packages/controller-ipc/src/*.ts). No AppKit import here — kept
        // separate from LoombreMenubar so the IPC client, discovery-file
        // reading, and menu-state derivation logic can be unit tested
        // without a running NSApplication.
        .target(
            name: "LoombreIPCKit",
            path: "Sources/LoombreIPCKit"
        ),

        // The actual menubar app: NSStatusItem + NSMenu, AppKit only.
        .executableTarget(
            name: "LoombreMenubar",
            dependencies: ["LoombreIPCKit"],
            path: "Sources/LoombreMenubar"
        ),

        .testTarget(
            name: "LoombreIPCKitTests",
            dependencies: ["LoombreIPCKit"],
            path: "Tests/LoombreIPCKitTests"
        ),
    ]
)
