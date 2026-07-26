// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/OpenWebTarget.swift
//
// Mirrors packages/controller-ipc/src/open-web-target.ts — GET
// /ipc/v1/open-web-target. Per the TS source's own comment, this contract
// never launches a browser itself; it returns the URL and the CONTROLLER
// (AppDelegate.swift, via NSWorkspace) is responsible for opening it.

import Foundation

public struct IPCOpenWebTargetResponse: Codable, Equatable {
    public let url: String

    public init(url: String) {
        self.url = url
    }
}
