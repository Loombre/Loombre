// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/Status.swift
//
// Mirrors packages/controller-ipc/src/status.ts — GET /ipc/v1/status.

import Foundation

public struct IPCStatusResponse: Codable, Equatable {
    public let ipcContractVersion: Int
    public let server: IPCProcessInfo
    public let worker: IPCProcessInfo
    /// nil while the server is not in a state that serves the web client.
    public let webUrl: String?
    public let provisioning: ProvisioningStatus

    public init(
        ipcContractVersion: Int,
        server: IPCProcessInfo,
        worker: IPCProcessInfo,
        webUrl: String?,
        provisioning: ProvisioningStatus
    ) {
        self.ipcContractVersion = ipcContractVersion
        self.server = server
        self.worker = worker
        self.webUrl = webUrl
        self.provisioning = provisioning
    }

    /// True when this response's contract version is one this client
    /// build understands. A newer server (higher ipcContractVersion) is
    /// NOT necessarily a hard error — additive changes within v1 are
    /// expected (contract-version.ts's own comment) — but the menubar
    /// surfaces a notice either way per the mission brief ("version +
    /// contract-version mismatch notice").
    public var matchesClientContractVersion: Bool {
        ipcContractVersion == controllerIpcContractVersion
    }
}
