// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/plugin-delivery/constants.spec.ts
//
// H2 (owner brief) discovered a third, undocumented-in-the-brief copy of
// the ADMIN_ONLY event-type list: apps/worker/src/plugin-delivery/
// constants.ts's LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES, a deliberate
// defense-in-depth duplicate of apps/server/src/plugins/event-taxonomy.ts's
// ADMIN_ONLY_EVENT_TYPES (that file's own header: "Keep this list in
// lockstep... apps/worker cannot import apps/server, the dependency graph
// runs the other way" — so this test hardcodes its own expected list too,
// same as event-taxonomy.spec.ts does on the server side, rather than
// importing across the boundary).

import { describe, expect, it } from "vitest";
import { LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES } from "../../src/plugin-delivery/constants.js";

describe("LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES (H-4 fix wave, defense in depth)", () => {
  it("stays in lockstep with apps/server's ADMIN_ONLY_EVENT_TYPES, including H2's user.restricted-pin-reset", () => {
    expect([...LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES].sort()).toEqual(
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
});
