// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/controller-ipc/src/crash-files.ts
//
// GET /ipc/v1/crash-files — list of local crash file paths + mtimes
// (P4.5/P4.14: process-level crash handlers write redacted local files;
// this is the "reveal in folder" surface, sharing is entirely manual per
// D14). Deliberately just path + mtimeMs, matching what "reveal in
// folder" + a sorted-by-recency list needs — no pagination: crash files
// are few, local, and pruned, not a catalog read (CLAUDE.md invariant 4's
// cursor-pagination requirement targets packages/db catalog reads, not
// this local filesystem listing).

export type CrashFilesRequest = Record<string, never>;

export const CRASH_FILES_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export interface CrashFileEntry {
  /** Absolute path to the crash file. */
  path: string;
  mtimeMs: number;
}

export interface CrashFilesResponse {
  files: CrashFileEntry[];
}

export const CRASH_FILE_ENTRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "mtimeMs"],
  properties: {
    path: { type: "string", minLength: 1 },
    mtimeMs: { type: "integer", minimum: 0 },
  },
} as const;

export const CRASH_FILES_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["files"],
  properties: {
    files: { type: "array", items: CRASH_FILE_ENTRY_SCHEMA },
  },
} as const;
