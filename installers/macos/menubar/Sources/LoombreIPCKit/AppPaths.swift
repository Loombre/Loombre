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
    public static let ipcDir = appSupportDir + "/ipc"

    public static var discoveryFileURL: URL {
        URL(fileURLWithPath: ipcDir).appendingPathComponent(IPCTransport.discoveryFilename)
    }

    public static var tokenFileURL: URL {
        URL(fileURLWithPath: ipcDir).appendingPathComponent(IPCTransport.tokenFilename)
    }
}
