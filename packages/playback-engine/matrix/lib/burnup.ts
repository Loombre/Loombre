// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Burn-up manifest loader — docs/PLAYBACK.md §11 step 1, STATE.md P3.2/P3.9d.
 *
 * `matrix/burnup.json` is the single source of truth for every case file's
 * CURRENT expected status: `"green"` (plan() must implement this case
 * correctly) or `"red"` (plan() is still expected to throw
 * NotImplementedError for it). Both matrix.spec.ts (`pnpm test:matrix`) and
 * matrix-meta.spec.ts (the gate) read this file:
 *   - matrix.spec.ts asserts every case's ACTUAL status matches the
 *     manifest — greening or regressing a case without editing burnup.json
 *     in the same PR is a hard failure (the regression law, made
 *     mechanical instead of vibes-based — STATE.md P3.2).
 *   - matrix-meta.spec.ts derives `planImplemented` (green count > 0) to
 *     retire the Phase-0 "plan() throws NotImplementedError" assertion
 *     automatically the day the first case greens (STATE.md P3.9d).
 *
 * This file lives in matrix/lib (node:fs is fine here — matrix/ is excluded
 * from both the playback-engine-purity dependency-cruiser rule and the
 * repo eslint config; only packages/playback-engine/src is held to the
 * zero-I/O purity law).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BURNUP_PATH = join(__dirname, "..", "burnup.json");

export type BurnupStatus = "green" | "red";

/** Case file name -> its current manifest status. */
export type BurnupManifest = Record<string, BurnupStatus>;

export function loadBurnupManifest(): BurnupManifest {
  const raw = readFileSync(BURNUP_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `matrix/burnup.json must be a JSON object mapping case file name -> "green"|"red", got ${JSON.stringify(parsed)}`,
    );
  }

  const manifest = parsed as Record<string, unknown>;
  for (const [file, status] of Object.entries(manifest)) {
    if (status !== "green" && status !== "red") {
      throw new Error(
        `matrix/burnup.json: case "${file}" has invalid status ${JSON.stringify(status)} (must be "green" or "red")`,
      );
    }
  }

  return manifest as BurnupManifest;
}

export interface BurnupCounts {
  green: number;
  red: number;
  total: number;
}

export function countBurnupStatuses(manifest: BurnupManifest): BurnupCounts {
  const values = Object.values(manifest);
  const green = values.filter((status) => status === "green").length;
  const red = values.filter((status) => status === "red").length;
  return { green, red, total: values.length };
}

/** True once at least one case has greened (STATE.md P3.9d trigger). */
export function hasAnyGreen(manifest: BurnupManifest): boolean {
  return Object.values(manifest).some((status) => status === "green");
}
