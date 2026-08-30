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

/** Both surfaces of one user's clearance, resolved in a single DB pass —
 *  see resolveSurfaces below. */
export interface ViewerSurfacePair {
  general: ViewerContext;
  restricted: ViewerContext;
}

@Injectable()
export class ViewerContextProvider {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * RZI surface scoping (docs/PLAN.md §6.4 as amended 2026-08-30,
   * DECISIONS.md §2026-08-29): the route-blind `resolve()` is GONE — every
   * caller chooses a surface explicitly, and grep-gates pass (f) pins who
   * may choose 'restricted'. Both contexts come from ONE resolution pass
   * (one set of DB reads), so a caller that needs both — the WS
   * broadcaster's per-socket delivery + relock detection — pays no double
   * read and can never see two halves resolved against different states.
   *
   * general: restrictedCleared is HARD false and restricted library ids
   * are excluded from allowedLibraryIds — defense in depth on top of the
   * guard's own surface clause (packages/db/src/query/guard.ts's
   * restrictedRowsVisible), so a general surface stays general even if
   * either layer regresses alone.
   */
  async resolveSurfaces(userId: string, nowMs: number): Promise<ViewerSurfacePair> {
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

    const restrictedAllowedLibraryIds = gates1through4
      ? [...permissions.generalLibraryIds, ...permissions.restrictedLibraryIds]
      : permissions.generalLibraryIds;

    return {
      general: {
        userId,
        allowedLibraryIds: permissions.generalLibraryIds,
        restrictedCleared: false,
        surface: "general",
      },
      restricted: {
        userId,
        allowedLibraryIds: restrictedAllowedLibraryIds,
        restrictedCleared: clearance.restrictedCleared,
        surface: "restricted",
      },
    };
  }

  /** The general-surface context — browse, search, home rails, watchlist/
   *  progress lists, people, tags. Restricted rows are unreachable through
   *  this context regardless of the viewer's live unlock state. */
  async resolveGeneralSurface(userId: string, nowMs: number): Promise<ViewerContext> {
    return (await this.resolveSurfaces(userId, nowMs)).general;
  }

  /** The restricted-capable context — the zone surfaces and the RZI-D3/D6/
   *  D7 full-clearance item-addressed reads ONLY (grep-gates pass (f) is
   *  the allowlist). Restricted rows still require the full five-gate
   *  clearance; this surface merely permits them when clearance holds. */
  async resolveRestrictedSurface(userId: string, nowMs: number): Promise<ViewerContext> {
    return (await this.resolveSurfaces(userId, nowMs)).restricted;
  }
}
