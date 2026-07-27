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
  // HONESTY NOTE (Lane R review): this is a SNAPSHOT test, not a lockstep
  // guarantee — it compares the worker constant against its own hardcoded
  // copy of the list below (no cross-import: the dependency graph forbids
  // apps/worker -> apps/server), and no automated gate enforces parity
  // across the three copies (server event-taxonomy.ts, this worker
  // constant, and each list's spec). Adding an admin-only event type means
  // updating ALL THREE by hand; this test catches a forgotten worker copy
  // only if you remember to update the expected list here — its value is
  // pinning the current inventory and forcing a conscious edit, not
  // detecting drift on its own.
  it("pins the worker's copy of the admin-only list (snapshot — update the server list, this constant, and this expected list together)", () => {
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
