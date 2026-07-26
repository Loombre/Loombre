// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/viewer-context.provider.ts
//
// The security keystone (task spec): builds a packages/db ViewerContext for
// a request, per docs/PLAN.md §6.4. Exported from SessionModule so future
// catalog endpoints (another wave) can inject it — this wave wires it up
// and uses it for the restricted-content endpoints only.
//
// allowedLibraryIds: every granted general library, PLUS granted restricted
// libraries ONLY if gates 1-4 all pass (task spec — a stricter reading than
// packages/db's ViewerContext doc comment, which mentions only gate 4;
// being conservative here costs nothing because packages/db's query guard
// additionally forces content_class = 'general' whenever restrictedCleared
// is false regardless of allowedLibraryIds, so this is defense-in-depth,
// not a correctness requirement — logged as a decision beyond the literal
// packages/db comment).
//
// restrictedCleared: gates 1-5 all pass, where gate 5 (session unlock) is
// RE-VERIFIED SERVER-SIDE from user_settings.restricted_unlocked_until_ms
// on every call — never trusted from an access-token claim (that claim is
// advisory only, per docs/PLAN.md §6.4 gate 5 and TokenService's header).
//
// Addendum A, lane S3: gates 1/2 (capabilityEnabled/majorityAgeYears) now
// come from SettingsService.getEffective() — read fresh on every resolve()
// call (this runs once per request), so a restricted.enabled/
// majorityAgeYears change is live for the very next request with no
// restart (both registry entries are requiresRestart:false). SettingsService
// is injected via CommonSettingsModule (this class moved there from
// CommonModule this lane — see common-settings.module.ts's header for why).

import { Injectable } from "@nestjs/common";
import type { ViewerContext } from "@loombre/db";
import { getLibraryPermissionSummary, getUserById, getUserSettings } from "@loombre/db";
import { DbProvider } from "./db.provider.js";
import { isRestrictedContentEnabled, resolveRestrictedMajorityAgeYears } from "./capabilities.js";
import { resolveClearance } from "./resolve-clearance.js";
import { SettingsService } from "../settings/settings.service.js";

@Injectable()
export class ViewerContextProvider {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly settingsService: SettingsService,
  ) {}

  async resolve(userId: string, nowMs: number): Promise<ViewerContext> {
    const db = this.dbProvider.db;

    const [user, settings, permissions] = await Promise.all([
      getUserById(db, userId),
      getUserSettings(db, userId),
      getLibraryPermissionSummary(db, userId),
    ]);

    const clearance = resolveClearance({
      capabilityEnabled: isRestrictedContentEnabled(this.settingsService),
      birthDate: user?.birth_date ?? null,
      nowMs,
      majorityAgeYears: resolveRestrictedMajorityAgeYears(this.settingsService),
      optIn: settings?.restricted_opt_in ?? false,
      hasPin: settings?.restricted_pin_hash != null,
      hasRestrictedLibraryPermission: permissions.restrictedLibraryIds.length > 0,
      unlockedUntilMs: settings?.restricted_unlocked_until_ms ?? null,
    });

    const gates1through4 =
      clearance.gates.g1 && clearance.gates.g2 && clearance.gates.g3 && clearance.gates.g4;

    const allowedLibraryIds = gates1through4
      ? [...permissions.generalLibraryIds, ...permissions.restrictedLibraryIds]
      : permissions.generalLibraryIds;

    return {
      userId,
      allowedLibraryIds,
      restrictedCleared: clearance.restrictedCleared,
    };
  }
}
