// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/admin-only-event-types.test.ts
//
// L3 (owner brief): the ONE intentional snapshot in the whole
// admin-only-event-type-list parity chain. Every other copy (apps/server's
// event-taxonomy.ts, apps/worker's plugin-delivery/constants.ts, both
// their specs, and packages/contract's envelope.schema.json `x-` array)
// now DERIVES from or is parity-tested against
// packages/shared/src/admin-only-event-types.ts — this is the single place
// a human confirms the inventory. Also asserts completeness against the
// contract: every admin-only type must actually be a member of the
// envelope's closed `type` enum (read off disk, not re-imported, so this
// test has no compile-time dependency on @loombre/contract shipping code —
// it ships none, see apps/server/src/plugins/event-taxonomy.ts's header).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_ONLY_EVENT_TYPES } from "../src/admin-only-event-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENVELOPE_SCHEMA_PATH = path.resolve(__dirname, "../../contract/event-schemas/envelope.schema.json");

describe("ADMIN_ONLY_EVENT_TYPES (canonical, L3)", () => {
  it("is exactly this 11-item inventory (the single place a human confirms the list)", () => {
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
        // Owner ledger L1 (adjudication A-2).
        "probe.failed",
      ].sort(),
    );
  });

  it("has no duplicate entries", () => {
    expect(new Set(ADMIN_ONLY_EVENT_TYPES).size).toBe(ADMIN_ONLY_EVENT_TYPES.length);
  });

  it("every member is present in the envelope schema's closed type enum (completeness against the contract)", () => {
    const raw = readFileSync(ENVELOPE_SCHEMA_PATH, "utf8");
    const envelope = JSON.parse(raw) as { properties: { type: { enum: string[] } } };
    const enumValues = new Set(envelope.properties.type.enum);
    for (const type of ADMIN_ONLY_EVENT_TYPES) {
      expect(enumValues.has(type), `${type} is in ADMIN_ONLY_EVENT_TYPES but missing from envelope.schema.json's type.enum`).toBe(true);
    }
  });
});
