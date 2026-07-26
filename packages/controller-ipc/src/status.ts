// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/controller-ipc/src/status.ts
//
// GET /ipc/v1/status — server+worker state, versions, web URL, and the
// embedded-PG ProvisioningStatus passthrough. This is the ONLY
// cross-package import this whole package makes (the brief this package
// was built against is explicit that it must be the only one): reusing
// @loombre/provisioning's ProvisioningStatus type + schema verbatim rather
// than re-declaring a parallel copy that could drift.
//
// Also carries VersionInfo (ipcContractVersion) — the version-negotiation
// mechanism: a newer controller calls /status first and compares this
// against its own CONTROLLER_IPC_CONTRACT_VERSION before relying on any
// field a older server/worker pair might not have.

import { PROVISIONING_STATUS_SCHEMA, type ProvisioningStatus } from "@loombre/provisioning";
import { PROCESS_INFO_SCHEMA, type ProcessInfo } from "./process-info.js";

export interface VersionInfo {
  ipcContractVersion: number;
}

export const VERSION_INFO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ipcContractVersion"],
  properties: {
    ipcContractVersion: { type: "integer", minimum: 1 },
  },
} as const;

export interface IpcStatusResponse extends VersionInfo {
  server: ProcessInfo;
  worker: ProcessInfo;
  /** null while the server is not in a state that serves the web client. */
  webUrl: string | null;
  provisioning: ProvisioningStatus;
}

export const IPC_STATUS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ipcContractVersion", "server", "worker", "webUrl", "provisioning"],
  properties: {
    ipcContractVersion: { type: "integer", minimum: 1 },
    server: PROCESS_INFO_SCHEMA,
    worker: PROCESS_INFO_SCHEMA,
    webUrl: { type: ["string", "null"] },
    provisioning: PROVISIONING_STATUS_SCHEMA,
  },
} as const;
