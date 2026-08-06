// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/controller-ipc/src/process-info.ts
//
// Shared shape for both the server and worker process's reported state in
// GET /ipc/v1/status (status.ts) — one closed vocabulary, used twice.

export type ProcessState = "stopped" | "starting" | "running" | "stopping" | "crashed";

/** Runtime-iterable mirror of ProcessState's members — single source of
 *  truth for both the TS union and PROCESS_INFO_SCHEMA's enum. */
export const PROCESS_STATES = [
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
] as const;

export interface ProcessInfo {
  state: ProcessState;
  /** OS process id while state is 'starting' | 'running' | 'stopping'; null otherwise. */
  pid: number | null;
  /** null until the process has actually started at least once this session. */
  startedAtMs: number | null;
  /** Version string of the running build (P4.11: single-sourced from package.json). */
  version: string;
}

export const PROCESS_INFO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state", "pid", "startedAtMs", "version"],
  properties: {
    state: { type: "string", enum: [...PROCESS_STATES] },
    pid: { type: ["integer", "null"], minimum: 1 },
    startedAtMs: { type: ["integer", "null"], minimum: 0 },
    version: { type: "string", minLength: 1 },
  },
} as const;
