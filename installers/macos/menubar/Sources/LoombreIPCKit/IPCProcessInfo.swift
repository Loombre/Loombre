// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/IPCProcessInfo.swift
//
// Mirrors packages/controller-ipc/src/process-info.ts. Named `IPCProcessInfo`
// / `IPCProcessState` (not `ProcessInfo`/`ProcessState`) to avoid colliding
// with Foundation.ProcessInfo — the TS source has no such naming pressure,
// this is a deliberate, documented rename at the Swift boundary, not a
// contract deviation (the wire shape and field names are unchanged).

import Foundation

public enum IPCProcessState: String, Codable, CaseIterable, Equatable {
    case stopped
    case starting
    case running
    case stopping
    case crashed
}

public struct IPCProcessInfo: Codable, Equatable {
    public let state: IPCProcessState
    /// OS process id while state is starting/running/stopping; nil otherwise.
    public let pid: Int32?
    /// nil until the process has actually started at least once this session.
    public let startedAtMs: Int64?
    public let version: String

    public init(state: IPCProcessState, pid: Int32?, startedAtMs: Int64?, version: String) {
        self.state = state
        self.pid = pid
        self.startedAtMs = startedAtMs
        self.version = version
    }
}
