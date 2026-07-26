// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/controller-ipc/src/server-lifecycle.ts
//
// POST /ipc/v1/server/start and POST /ipc/v1/server/stop. Both take an
// empty body (the controller just requests a transition; there is nothing
// to parameterize) and return the same shape — one type, two
// endpoint-named aliases, so a caller reading only the start or only the
// stop side sees a name that matches the operation it imported it for.

import { PROCESS_STATES, type ProcessState } from "./process-info.js";

export type IpcServerLifecycleRequest = Record<string, never>;

export const IPC_SERVER_LIFECYCLE_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export interface IpcServerActionResponse {
  /** false when the request was a no-op (e.g. start called while already running). */
  accepted: boolean;
  state: ProcessState;
}

export const IPC_SERVER_ACTION_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["accepted", "state"],
  properties: {
    accepted: { type: "boolean" },
    state: { type: "string", enum: [...PROCESS_STATES] },
  },
} as const;

export type IpcServerStartRequest = IpcServerLifecycleRequest;
export type IpcServerStartResponse = IpcServerActionResponse;
export const IPC_SERVER_START_REQUEST_SCHEMA = IPC_SERVER_LIFECYCLE_REQUEST_SCHEMA;
export const IPC_SERVER_START_RESPONSE_SCHEMA = IPC_SERVER_ACTION_RESPONSE_SCHEMA;

export type IpcServerStopRequest = IpcServerLifecycleRequest;
export type IpcServerStopResponse = IpcServerActionResponse;
export const IPC_SERVER_STOP_REQUEST_SCHEMA = IPC_SERVER_LIFECYCLE_REQUEST_SCHEMA;
export const IPC_SERVER_STOP_RESPONSE_SCHEMA = IPC_SERVER_ACTION_RESPONSE_SCHEMA;
