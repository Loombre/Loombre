// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/ServerLifecycle.swift
//
// Mirrors packages/controller-ipc/src/server-lifecycle.ts — POST
// /ipc/v1/server/start and POST /ipc/v1/server/stop. Both take an empty
// body and return the same shape; the TS side aliases one type under two
// names for call-site clarity, mirrored the same way here.

import Foundation

public struct IPCServerActionResponse: Codable, Equatable {
    /// false when the request was a no-op (e.g. start called while already running).
    public let accepted: Bool
    public let state: IPCProcessState

    public init(accepted: Bool, state: IPCProcessState) {
        self.accepted = accepted
        self.state = state
    }
}

public typealias IPCServerStartResponse = IPCServerActionResponse
public typealias IPCServerStopResponse = IPCServerActionResponse
