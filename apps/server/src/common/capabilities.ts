// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/capabilities.ts
//
// GET /system/capabilities backing values + the gate-1 flag shared with
// ViewerContextProvider/resolveClearance (docs/PLAN.md §6.4 gate 1,
// STATE.md P1.19).
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration): these three
// used to be a raw `process.env["LOOMBRE_RESTRICTED_ENABLED"]` read and two
// hardcoded constants ("no instance-settings table exists yet", P1.19's own
// note — that table now exists, migrations/0013_server_settings.sql).
// Every caller now passes its own injected SettingsService (packages/shared/
// src/settings-registry.ts's restricted.enabled/restricted.majorityAgeYears/
// restricted.defaultUnlockDurationMs entries) so the effective value is
// read AT USE TIME from the service's cache (env-pin > DB > default, A8),
// never re-read from process.env directly at this or any downstream site.
// Defaults below match the registry's own defaults exactly (false / 18 /
// 30 minutes) and are used only defensively if a caller somehow calls these
// before the service has bootstrapped (getEffective returns undefined),
// which the service's own requireLoaded() guard makes unreachable in
// practice at request time.

import type { SettingsService } from "../settings/settings.service.js";

export function isRestrictedContentEnabled(settingsService: SettingsService): boolean {
  return (settingsService.getEffective("restricted.enabled")?.value as boolean | undefined) ?? false;
}

/** D13 hard floor, instance-configurable UPWARD only via the
 *  restricted.majorityAgeYears registry entry. `Math.max(18, ...)` here is
 *  deliberate belt-and-braces (A3: "the >=18 floor must ALSO stay enforced
 *  at the consumption site"), redundant with BOTH the registry schema's own
 *  `.min(18)` and settings.service.ts's explicit second check on write —
 *  three independent enforcement points can never regress together. */
export function resolveRestrictedMajorityAgeYears(settingsService: SettingsService): number {
  const effective = settingsService.getEffective("restricted.majorityAgeYears")?.value as number | undefined;
  return Math.max(18, effective ?? 18);
}

/** Gate 5 default unlock duration (task spec, docs/PLAN.md §6.4 gate 5). */
export function resolveRestrictedUnlockDurationMs(settingsService: SettingsService): number {
  return (settingsService.getEffective("restricted.defaultUnlockDurationMs")?.value as number | undefined) ?? 30 * 60 * 1000;
}

/** The `restricted-content` entry's description text in GET
 *  /system/capabilities' `details` map. Lives here, next to the disclosure
 *  rule below, so the flag's copy and its visibility rule cannot drift
 *  apart. */
export const RESTRICTED_CAPABILITY_DESCRIPTION =
  "Native adult/restricted-content gating (docs/PLAN.md §6.4). Off by default.";

/**
 * api-restricted-leak-F1 (2026-08-20/21 QA sweep, OWNER RULING 2026-08-24):
 * gate 1's VALUE is auth-only.
 *
 * GET /system/capabilities is public and stays public — but it used to
 * report `restricted-content: { enabled: <the live restricted.enabled
 * setting> }` to ANY anonymous caller, which let a passer-by detect whether
 * this particular operator had switched adult-content gating on. Nothing
 * user- or title-level leaked; the leak was instance CONFIGURATION, and it
 * contradicted §6.4's own design principle that the zone is invisible
 * unless every gate passes.
 *
 * The ruling: an authenticated session (ANY session — admin or not,
 * entitled or not) gets the full report; an unauthenticated caller gets the
 * report with this entry OMITTED — absent, never `enabled: false`. Absence
 * is deliberately the LESS informative of the two shapes: `false` would
 * still be an answer about this instance, and an operator who turns the
 * setting on would flip an anonymously-observable bit. With omission, the
 * anonymous response is byte-identical either way (pinned by
 * apps/server/test/capabilities-auth-scoping.e2e.spec.ts).
 *
 * Entitlement is untouched: gates 2-5 (opt-in, age, PIN, unlock —
 * resolveClearance/ViewerContextProvider) decide who may SEE restricted
 * content, and they still run exactly as before. This function moves gate
 * 1's visibility only, and it is the ONLY consumer of `isAuthenticated` in
 * this file — `isRestrictedContentEnabled` above stays the unconditional
 * server-side truth every gate keeps reading.
 *
 * Returns the detail object to publish, or `undefined` meaning "publish
 * nothing for this flag" — the caller must then omit it from BOTH `details`
 * and the compact `flags` list (a flag present in one and absent from the
 * other would leak the same bit through the other channel).
 */
export function resolveRestrictedCapabilityDetail(
  settingsService: SettingsService,
  isAuthenticated: boolean,
): { enabled: boolean; description: string } | undefined {
  if (!isAuthenticated) return undefined;
  return {
    enabled: isRestrictedContentEnabled(settingsService),
    description: RESTRICTED_CAPABILITY_DESCRIPTION,
  };
}
