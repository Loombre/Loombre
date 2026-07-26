// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreMenubar/main.swift
//
// Entry point for the pure-AppKit menubar executable (no SwiftUI, no
// Xcode project — `swift build -c release` produces this Mach-O directly;
// build-pkg.mjs wraps it into a minimal Loombre.app bundle for
// installation, see installers/macos/LAYOUT.md).

import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
