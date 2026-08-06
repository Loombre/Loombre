// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning/src/provisioning-status.ts
//
// Health/status half of the ProvisioningInterface seam. 'external' is the
// LOOMBRE external-PG env-var path (D1: "external PG via env var") — P4.2
// keeps that path first-class and equally tested, so it gets its own
// explicit modeled state rather than being inferred from an absent
// dataDir: when the external-PG env var is set, provisioning must be
// INERT (never attempts initdb/upgrade/repair against a database Loombre
// does not own), and 'external' is how a caller proves that inertness was
// actually chosen, rather than merely "provisioning hasn't run yet" (which
// is 'absent'). This is a locked decision, not a convenience shortcut.

export type ProvisioningState =
  | "absent"
  | "provisioning"
  | "ready"
  | "upgrading"
  | "corrupt"
  | "external";

/** Runtime-iterable mirror of ProvisioningState's members — single source
 *  of truth for both the TS union and PROVISIONING_STATUS_SCHEMA's enum. */
export const PROVISIONING_STATES = [
  "absent",
  "provisioning",
  "ready",
  "upgrading",
  "corrupt",
  "external",
] as const;

export interface ProvisioningStatus {
  state: ProvisioningState;
  /**
   * Full PG version string once known; null before the first successful
   * initdb and for 'external' (Loombre does not probe the version of a
   * database it does not own — that is a separate health surface's job,
   * not provisioning's).
   */
  pgVersion: string | null;
  /** Absolute data directory once known; null for 'absent' and 'external'. */
  dataDir: string | null;
  lastCheckMs: number;
  detail?: string;
}

export const PROVISIONING_STATUS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state", "pgVersion", "dataDir", "lastCheckMs"],
  properties: {
    state: { type: "string", enum: [...PROVISIONING_STATES] },
    pgVersion: { type: ["string", "null"] },
    dataDir: { type: ["string", "null"] },
    lastCheckMs: { type: "integer", minimum: 0 },
    detail: { type: "string" },
  },
} as const;
