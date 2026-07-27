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
  it("ADMIN_ONLY_EVENT_TYPES is exactly the 10 types ws-broadcaster.service.ts gates", () => {
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
        "user.restricted-pin-reset",
      ].sort(),
    );
  });

  it("none of the 10 ADMIN_ONLY types appear in the grantable taxonomy", () => {
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

  it("the taxonomy is exactly 25 (envelope enum) minus 10 (admin-only) = 15 types", () => {
    resetOutboxEventTaxonomyCacheForTests();
    expect(getOutboxEventTaxonomy()).toHaveLength(15);
  });

  // H2: the CLI PIN-reset recovery event is instance-administration/audit
  // activity (packages/contract/event-schemas/user.restricted-pin-reset.
  // schema.json), never content a plugin subscriber should see — same
  // posture as job.updated/settings.updated/plugin.*, for the same reason.
  it("user.restricted-pin-reset (H2) is ADMIN_ONLY, never grantable", () => {
    resetOutboxEventTaxonomyCacheForTests();
    expect(ADMIN_ONLY_EVENT_TYPES).toContain("user.restricted-pin-reset");
    expect(getOutboxEventTaxonomy().includes("user.restricted-pin-reset")).toBe(false);
  });
});
