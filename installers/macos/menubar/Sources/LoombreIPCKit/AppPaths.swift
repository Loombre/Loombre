// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/AppPaths.swift
//
// Resolving the app-data base directory is explicitly the CALLER's concern
// per every frozen contract this client speaks (transport.ts's own
// comment: "resolving that base path is the CALLER's concern, same as
// @loombre/provisioning's dataDir"). installers/macos/LAYOUT.md is this
// installer's decision: system-wide /Library/Application Support/Loombre
// (not ~/Library/...), because the server/worker are LaunchDaemons that
// serve while logged out.

import Foundation

public enum LoombreAppPaths {
    public static let appSupportDir = "/Library/Application Support/Loombre"

    // Discovery/token files live at the DATA-DIR ROOT — "alongside, not
    // inside, the data subdirs" per packages/controller-ipc's transport
    // contract, and exactly where apps/server/src/ipc/discovery-files.ts
    // writes them (the Windows tray reads the same root). This enum
    // previously pointed at an "ipc/" subdirectory nothing ever wrote —
    // the installer completeness audit's menubar-can-never-connect gap.
    public static var discoveryFileURL: URL {
        URL(fileURLWithPath: appSupportDir).appendingPathComponent(IPCTransport.discoveryFilename)
    }

    public static var tokenFileURL: URL {
        URL(fileURLWithPath: appSupportDir).appendingPathComponent(IPCTransport.tokenFilename)
    }

    /// Where crash reports land when one ever happens — <dataDir>/crashes,
    /// the single shared crashDirPath (packages/shared/src/crash-dir.ts;
    /// apps/server/src/crash/writer.ts creates it lazily on first crash).
    /// Informational only here: the menubar mentions it in the
    /// "no crash files found" dialog, it never reads the directory itself
    /// (listing goes through GET /ipc/v1/crash-files).
    public static let crashesDir = appSupportDir + "/crashes"
}
