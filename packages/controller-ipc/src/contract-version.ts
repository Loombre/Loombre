// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/controller-ipc/src/contract-version.ts
//
// Version of the controller<->server/worker IPC contract. Every response
// from GET /ipc/v1/status carries this (see status.ts's VersionInfo) so a
// newer controller build can detect it is talking to an older server/worker
// pair before it relies on a field that pair does not have yet. The path
// prefix (see transport.ts's IPC_BASE_PATH) carries the coarse "v1"; this
// is the fine-grained number for additive changes within v1.

export const CONTROLLER_IPC_CONTRACT_VERSION = 1 as const;
