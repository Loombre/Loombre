// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/ContractVersion.swift
//
// Mirrors packages/controller-ipc/src/contract-version.ts verbatim.
// SYNC NOTE: this package has no build-time codegen from the TS source
// (Swift SDK generation is post-v1 per docs/PLAN.md §3's client list) —
// bumping CONTROLLER_IPC_CONTRACT_VERSION on the TS side requires a
// matching manual edit here. `statusReflectsCurrentContract(_:)` in
// IPCClient.swift is exactly the runtime check that makes a forgotten
// bump visible to a user instead of silently misbehaving.

public let controllerIpcContractVersion = 1
