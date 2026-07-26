// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/event-taxonomy.spec.ts
//
// H-4 fix wave regression test: getOutboxEventTaxonomy() used to return
// the WHOLE envelope enum (21 types at the time; 23 as of Phosphor Wave 2
// lane L3's watchlist.added/watchlist.removed addition) with no ADMIN_ONLY
// exclusion — a
// plugin manifest could REQUEST job.updated/settings.updated/any plugin.*
// type, an admin could GRANT it, and the delivery loop had no admin-only
// gate at all. This test proves the exclusion at the single source of
// truth both the registration-time gate (plugin-registration.service.ts's
// validateGrantAgainstManifest) and ws-broadcaster.service.ts's own
// ADMIN_ONLY_TYPES now share.

import { describe, expect, it } from "vitest";
import { ADMIN_ONLY_EVENT_TYPES, getOutboxEventTaxonomy, resetOutboxEventTaxonomyCacheForTests } from "./event-taxonomy.js";

describe("H-4 fix wave: getOutboxEventTaxonomy excludes ADMIN_ONLY_EVENT_TYPES", () => {
  it("ADMIN_ONLY_EVENT_TYPES is exactly the 9 types ws-broadcaster.service.ts gates", () => {
    expect([...ADMIN_ONLY_EVENT_TYPES].sort()).toEqual(
      [
        "job.updated",
        "settings.updated",
        "plugin.registered",
        "plugin.updated",
        "plugin.enabled",
        "plugin.disabled",
        "plugin.removed",
        "plugin.health-changed",
        "metadata.match-candidates",
      ].sort(),
    );
  });

  it("none of the 9 ADMIN_ONLY types appear in the grantable taxonomy", () => {
    resetOutboxEventTaxonomyCacheForTests();
    const taxonomy = new Set(getOutboxEventTaxonomy());
    for (const adminOnlyType of ADMIN_ONLY_EVENT_TYPES) {
      expect(taxonomy.has(adminOnlyType)).toBe(false);
    }
  });

  it("ordinary content-scoped types remain grantable", () => {
    resetOutboxEventTaxonomyCacheForTests();
    const taxonomy = new Set(getOutboxEventTaxonomy());
    for (const ordinaryType of ["item.added", "playback.started", "scan.completed", "user.created"]) {
      expect(taxonomy.has(ordinaryType)).toBe(true);
    }
  });

  // Phosphor Wave 2 lane L3: watchlist.added/watchlist.removed are
  // USER_ONLY_TYPES (private-to-the-acting-user delivery), NOT ADMIN_ONLY —
  // the same posture restricted.locked/unlocked and progress.updated
  // already have (a user-activity event, pseudonymizable via the existing
  // default-on ACTOR_FIELD_MAP mechanism, not an instance-administration
  // event). They remain grantable.
  it("watchlist.added/watchlist.removed remain grantable (user-scoped, not admin-only)", () => {
    resetOutboxEventTaxonomyCacheForTests();
    const taxonomy = new Set(getOutboxEventTaxonomy());
    expect(taxonomy.has("watchlist.added")).toBe(true);
    expect(taxonomy.has("watchlist.removed")).toBe(true);
  });

  it("the taxonomy is exactly 24 (envelope enum) minus 9 (admin-only) = 15 types", () => {
    resetOutboxEventTaxonomyCacheForTests();
    expect(getOutboxEventTaxonomy()).toHaveLength(15);
  });
});
