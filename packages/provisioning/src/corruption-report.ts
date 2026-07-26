// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning/src/corruption-report.ts
//
// The 'corrupt' ProvisioningStatus state (provisioning-status.ts) always
// carries one of these as its diagnostic detail. Typed reason enum ONLY —
// "do not invent prose-only errors" is a binding constraint from the brief
// this package was built against, not a style preference: `detail` below
// is supplementary free text, never a substitute for `reason`, and a
// caller must be able to `switch` over `reason` exhaustively.

import { ABSOLUTE_PATH_PATTERN } from "./absolute-path.js";

export type CorruptionReason =
  /** The data directory this status/report is about does not exist on disk. */
  | "missing-data-dir"
  /** Data directory exists but has no PG_VERSION file — not an initialized PG cluster. */
  | "missing-version-file"
  /** PG_VERSION content does not match the pinned major (e.g. a leftover prior-major data dir). */
  | "pg-version-mismatch"
  /** initdb was interrupted partway (killed process, disk full mid-write, power loss). */
  | "incomplete-initdb"
  /** The provisioning process could not read/write the data directory. */
  | "permission-denied"
  /** Postgres could not complete crash recovery on startup. */
  | "crash-recovery-failed"
  /** Disk ran out of space during a write to the data directory. */
  | "disk-full"
  /** Postgres reported a page/data checksum failure. */
  | "checksum-failure"
  /** A failure was detected but does not match any reason above. */
  | "unknown";

/** Runtime-iterable mirror of CorruptionReason's members — single source
 *  of truth for both the TS union and CORRUPTION_REPORT_SCHEMA's enum. */
export const CORRUPTION_REASONS: readonly CorruptionReason[] = [
  "missing-data-dir",
  "missing-version-file",
  "pg-version-mismatch",
  "incomplete-initdb",
  "permission-denied",
  "crash-recovery-failed",
  "disk-full",
  "checksum-failure",
  "unknown",
];

export interface CorruptionReport {
  reason: CorruptionReason;
  dataDir: string;
  detectedAtMs: number;
  /** Supplementary free text ONLY — never a substitute for `reason`. */
  detail?: string;
}

export const CORRUPTION_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reason", "dataDir", "detectedAtMs"],
  properties: {
    reason: { type: "string", enum: [...CORRUPTION_REASONS] },
    dataDir: { type: "string", minLength: 1, pattern: ABSOLUTE_PATH_PATTERN },
    detectedAtMs: { type: "integer", minimum: 0 },
    detail: { type: "string" },
  },
} as const;
