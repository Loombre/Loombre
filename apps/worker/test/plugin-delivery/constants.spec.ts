// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/plugin-delivery/constants.spec.ts
//
// H2 (owner brief) discovered a third, undocumented-in-the-brief copy of
// the ADMIN_ONLY event-type list: apps/worker/src/plugin-delivery/
// constants.ts's LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES, a deliberate
// defense-in-depth duplicate of apps/server/src/plugins/event-taxonomy.ts's
// ADMIN_ONLY_EVENT_TYPES.
//
// L3 (owner brief) closed that drift risk structurally: both
// event-taxonomy.ts's ADMIN_ONLY_EVENT_TYPES and this file's
// LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES are now straight re-exports of
// packages/shared/src/admin-only-event-types.ts (apps/worker already
// depends on @loombre/shared — no dependency-direction problem to route
// around). This test used to hardcode its own expected list (a SNAPSHOT,
// per the prior honesty note — Lane R review) because no cross-import was
// possible; it now asserts DERIVATION (reference identity against the
// canonical import) instead, which can never silently drift no matter how
// the inventory changes. The one place the 10-item inventory is still
// spelled out as a literal is
// packages/shared/test/admin-only-event-types.test.ts (the single
// intentional snapshot).

import { describe, expect, it } from "vitest";
import { ADMIN_ONLY_EVENT_TYPES as CANONICAL_ADMIN_ONLY_EVENT_TYPES } from "@loombre/shared/admin-only-event-types";
import { LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES } from "../../src/plugin-delivery/constants.js";

describe("LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES (H-4 fix wave, defense in depth)", () => {
  it("is exactly the canonical packages/shared list (identity, not a re-typed copy)", () => {
    expect(LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES).toBe(CANONICAL_ADMIN_ONLY_EVENT_TYPES);
  });
});
