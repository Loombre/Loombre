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
