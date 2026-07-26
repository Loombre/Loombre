// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning/src/upgrade-plan.ts
//
// P4.2: "PG major upgrades via automated dump/restore job with pre-upgrade
// backup." The closed step enum below is the ENTIRE vocabulary the
// automated upgrade job may report progress in — a step outside this list
// cannot be expressed, by construction (fixture tests assert Ajv rejects
// anything else).

import { ABSOLUTE_PATH_PATTERN } from "./absolute-path.js";

export type UpgradeStep =
  | "stop"
  | "backup"
  | "dumpall"
  | "initdb-new"
  | "restore"
  | "verify"
  | "swap"
  | "restart";

/** Canonical order the automated upgrade job executes these in. Also the
 *  runtime-iterable single source of truth for UpgradeStep's members. */
export const UPGRADE_STEPS: readonly UpgradeStep[] = [
  "stop",
  "backup",
  "dumpall",
  "initdb-new",
  "restore",
  "verify",
  "swap",
  "restart",
];

export interface UpgradePlan {
  /** Full PG version string being upgraded from, e.g. "17.4". */
  fromVersion: string;
  /** Full PG version string being upgraded to, e.g. "18.0". */
  toVersion: string;
  /** Absolute path the pre-upgrade backup is written to before any destructive step runs. */
  backupPath: string;
  steps: UpgradeStep[];
}

/**
 * Not reused from provisioning-request.ts's PG_FULL_VERSION_PATTERN on
 * purpose: an UpgradePlan's fromVersion/toVersion are not bound by today's
 * "major >= 17" pin the way a fresh ProvisioningRequest is (an upgrade
 * plan's whole job is to move PAST the current pin) — same shape, no
 * minimum-major floor.
 */
export const UPGRADE_PLAN_VERSION_PATTERN = "^[0-9]+\\.[0-9]+(\\.[0-9]+)?$";

export const UPGRADE_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fromVersion", "toVersion", "backupPath", "steps"],
  properties: {
    fromVersion: { type: "string", pattern: UPGRADE_PLAN_VERSION_PATTERN },
    toVersion: { type: "string", pattern: UPGRADE_PLAN_VERSION_PATTERN },
    backupPath: { type: "string", minLength: 1, pattern: ABSOLUTE_PATH_PATTERN },
    steps: {
      type: "array",
      minItems: 1,
      items: { type: "string", enum: [...UPGRADE_STEPS] },
      uniqueItems: true,
    },
  },
} as const;
