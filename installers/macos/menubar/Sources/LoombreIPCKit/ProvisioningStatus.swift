// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/ProvisioningStatus.swift
//
// Mirrors packages/provisioning/src/provisioning-status.ts. Pulled in
// because IPCStatusResponse embeds it verbatim (status.ts's "the ONLY
// cross-package import this whole package makes" comment) — the Swift
// client needs the same shape to decode GET /ipc/v1/status. This is the
// one place LoombreIPCKit mirrors a package outside controller-ipc itself,
// matching the TS side's own documented exception.

import Foundation

public enum ProvisioningState: String, Codable, CaseIterable, Equatable {
    case absent
    case provisioning
    case ready
    case upgrading
    case corrupt
    case external
}

public struct ProvisioningStatus: Codable, Equatable {
    public let state: ProvisioningState
    /// nil before the first successful initdb and for .external.
    public let pgVersion: String?
    /// nil for .absent and .external.
    public let dataDir: String?
    public let lastCheckMs: Int64
    public let detail: String?

    public init(state: ProvisioningState, pgVersion: String?, dataDir: String?, lastCheckMs: Int64, detail: String? = nil) {
        self.state = state
        self.pgVersion = pgVersion
        self.dataDir = dataDir
        self.lastCheckMs = lastCheckMs
        self.detail = detail
    }
}
