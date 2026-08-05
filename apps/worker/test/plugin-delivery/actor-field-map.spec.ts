// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/plugin-delivery/actor-field-map.spec.ts
//
// LPP v1 mission §3.2 — the pseudonymization actor-field map
// exhaustiveness test (repo precedent: apps/web/src/lib/
// playback-reasons.test.ts's "import the closed enum and assert
// exhaustiveness" deliverable). The REQUIRED type list is read directly
// from the REAL packages/contract/event-schemas/envelope.schema.json enum
// (21 types as of Lane W2 landing: 15 pre-LPP + 6 plugin.*) — never
// hardcoded here — so this test fails the moment a new event type appears
// anywhere without a mapping decision, per the mission brief's
// requirement. A second independent check re-derives each REAL type's
// actor-field inventory straight off its own schema.json (never
// copy-pasted from actor-field-map.ts), so the map cannot silently drift
// from the schemas it claims to describe.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTOR_FIELD_MAP, pseudonymizePayload, pseudonymizeUserId } from "../../src/plugin-delivery/actor-field-map.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVENT_SCHEMAS_DIR = path.resolve(__dirname, "../../../../packages/contract/event-schemas");

interface JsonSchema {
  properties?: Record<string, unknown>;
}

function readEnvelopeEventTypes(): string[] {
  const envelope = JSON.parse(readFileSync(path.join(EVENT_SCHEMAS_DIR, "envelope.schema.json"), "utf8")) as {
    properties: { type: { enum: string[] } };
  };
  return envelope.properties.type.enum;
}

/** Any field name whose value the corresponding schema documents as
 *  carrying a real user id OR (M-9 fix wave) another stable,
 *  user-correlating identifier — determined the same way this file (and
 *  actor-field-map.ts) both do it independently: a field literally named
 *  `userId`, `actorUserId`, `deviceId`, or `sessionId`. This is a closed,
 *  deliberate heuristic (not "any field that sounds like an id") matching
 *  every field actor-field-map.ts actually maps today. */
const USER_ID_FIELD_NAMES = new Set(["userId", "actorUserId", "deviceId", "sessionId"]);

function readRealActorFields(eventType: string): string[] {
  const fileName = `${eventType}.schema.json`;
  const schema = JSON.parse(readFileSync(path.join(EVENT_SCHEMAS_DIR, fileName), "utf8")) as JsonSchema;
  const propertyNames = Object.keys(schema.properties ?? {});
  return propertyNames.filter((p) => USER_ID_FIELD_NAMES.has(p));
}

describe("ACTOR_FIELD_MAP exhaustiveness over the REAL envelope enum", () => {
  const realTypes = readEnvelopeEventTypes();

  it("envelope.schema.json enumerates exactly 46 types (15 pre-LPP + 6 plugin.* + 2 watchlist.* [L3] + 1 metadata.match-candidates [L2], Phosphor Wave 2 + 1 user.restricted-pin-reset [H2] + 1 probe.failed [owner ledger L1] + 1 stash.provider.disabled [Stash SQLite metadata sync, S3/K12] + 2 stash.sync.* [Stash SQLite metadata sync, S8/K12, Lane C] + 1 mail.failed [optional mail transport run, E6/M6] + 3 user.invited/user.invite-revoked/user.claimed [E2, Lane A] + 1 user.password-reset [E3/M14/M15, Lane B] + 1 session.revoked-by-password-change [Current-password re-auth on self-changes, G5] + 2 notice.published/notice.cancelled [admin broadcast notifications — system notices, N2/NG1, Lane A] + 9 remote.*/tunnel.connector.state/posture.*/probe.arrived [Loombre Remote — embedded WireGuard + three-path wizard + reachability proof + posture card, R9, Wave 0])", () => {
    expect(realTypes).toHaveLength(46);
    expect(realTypes.filter((t) => t.startsWith("plugin."))).toHaveLength(6);
    expect(realTypes.filter((t) => t.startsWith("watchlist."))).toHaveLength(2);
  });

  it("ACTOR_FIELD_MAP has EXACTLY one entry per real type — no missing, no extra", () => {
    const mapped = new Set(Object.keys(ACTOR_FIELD_MAP));
    expect(mapped.size).toBe(realTypes.length);
    for (const type of realTypes) {
      expect(mapped.has(type)).toBe(true);
    }
    for (const key of mapped) {
      expect(realTypes).toContain(key);
    }
  });

  for (const type of realTypes) {
    it(`"${type}"'s mapped actor fields match its real schema.json (re-derived independently)`, () => {
      const expected = readRealActorFields(type).sort();
      const actual = [...(ACTOR_FIELD_MAP[type] ?? [])].sort();
      expect(actual).toEqual(expected);
    });
  }

  it("none of the 6 plugin.* types carry a user-id-bearing payload field (LD4/LD9: no manifest, no secret, no actor in payload)", () => {
    for (const type of realTypes.filter((t) => t.startsWith("plugin."))) {
      expect(ACTOR_FIELD_MAP[type]).toEqual([]);
    }
  });
});

describe("pseudonymizeUserId", () => {
  it("is deterministic hex hmac-sha256(salt, userId)", () => {
    const a = pseudonymizeUserId("salt-a", "user-1");
    const b = pseudonymizeUserId("salt-a", "user-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stability: same (plugin salt, user) always produces the same pseudonym across calls", () => {
    const salt = "stable-salt";
    const p1 = pseudonymizeUserId(salt, "user-42");
    const p2 = pseudonymizeUserId(salt, "user-42");
    const p3 = pseudonymizeUserId(salt, "user-42");
    expect(new Set([p1, p2, p3]).size).toBe(1);
  });

  it("cross-plugin unlinkability: different salts produce different pseudonyms for the SAME real user id", () => {
    const pluginASalt = "plugin-a-salt";
    const pluginBSalt = "plugin-b-salt";
    const forA = pseudonymizeUserId(pluginASalt, "user-shared");
    const forB = pseudonymizeUserId(pluginBSalt, "user-shared");
    expect(forA).not.toBe(forB);
  });

  it("different real user ids produce different pseudonyms under the same salt", () => {
    const salt = "one-salt";
    expect(pseudonymizeUserId(salt, "user-1")).not.toBe(pseudonymizeUserId(salt, "user-2"));
  });
});

describe("pseudonymizePayload", () => {
  const opts = (overrides: Partial<{ pseudonymizeActorIds: boolean; salt: string | null }> = {}) => ({
    pseudonymizeActorIds: true,
    salt: "test-salt",
    ...overrides,
  });

  it("default-on: real user ids are BYTE-ABSENT from the pseudonymized payload", () => {
    const realUserId = "11111111-2222-7333-8444-555555555555";
    const payload = { userId: realUserId, positionMs: 1000 };
    const result = pseudonymizePayload("progress.updated", payload, opts());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(realUserId);
    expect(result.userId).not.toBe(realUserId);
    expect(result.positionMs).toBe(1000); // non-actor fields pass through untouched
  });

  it("toggle-off: real user ids pass through unchanged", () => {
    const realUserId = "11111111-2222-7333-8444-555555555555";
    const payload = { userId: realUserId };
    const result = pseudonymizePayload("progress.updated", payload, opts({ pseudonymizeActorIds: false }));
    expect(result.userId).toBe(realUserId);
    expect(result).toBe(payload); // referential-equality fast path, see doc comment
  });

  it("event types with no mapped actor field (e.g. plugin.registered) are returned unchanged", () => {
    const payload = { pluginId: "p1", name: "n", baseUrl: "http://x", contentClass: "general", grantedCapabilityTypes: [], eventTypes: [], registeredAtMs: 1 };
    const result = pseudonymizePayload("plugin.registered", payload, opts());
    expect(result).toBe(payload);
  });

  it("stability across batches: the same user's pseudonym is identical in two separate calls", () => {
    const realUserId = "aaaa1111-2222-7333-8444-555555555555";
    const first = pseudonymizePayload("user.created", { userId: realUserId }, opts());
    const second = pseudonymizePayload("user.created", { userId: realUserId }, opts());
    expect(first.userId).toBe(second.userId);
  });

  it("fails CLOSED when pseudonymization is required but no salt is available (never leaks the real id)", () => {
    const realUserId = "bbbb1111-2222-7333-8444-555555555555";
    const result = pseudonymizePayload("settings.updated", { actorUserId: realUserId, key: "x" }, opts({ salt: null }));
    expect(result.actorUserId).toBeNull();
    expect(JSON.stringify(result)).not.toContain(realUserId);
  });

  it("settings.updated actorUserId is pseudonymized", () => {
    const realUserId = "cccc1111-2222-7333-8444-555555555555";
    const result = pseudonymizePayload("settings.updated", { actorUserId: realUserId, key: "k", oldValue: 1, newValue: 2 }, opts());
    expect(result.actorUserId).not.toBe(realUserId);
    expect(result.key).toBe("k");
  });

  // M-9 fix wave: deviceId/sessionId are stable, per-device/session
  // correlators — not real user ids, but a subscriber granted a playback
  // type could otherwise build a durable per-device viewing history purely
  // from them. Now pseudonymized with the same salt/HMAC mechanism, and
  // BYTE-ABSENT from the delivered payload by default, matching the
  // existing real-user-id proof above exactly.
  it.each(["playback.started", "playback.progress", "playback.ended"])(
    "M-9: %s pseudonymizes BOTH deviceId and sessionId (byte-absent by default)",
    (type) => {
      const realDeviceId = "dddd1111-2222-7333-8444-555555555555";
      const realSessionId = "eeee1111-2222-7333-8444-555555555555";
      const payload = { deviceId: realDeviceId, sessionId: realSessionId, itemId: "item-1" };
      const result = pseudonymizePayload(type, payload, opts());
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(realDeviceId);
      expect(serialized).not.toContain(realSessionId);
      expect(result.deviceId).not.toBe(realDeviceId);
      expect(result.sessionId).not.toBe(realSessionId);
      expect(result.itemId).toBe("item-1"); // non-actor fields pass through untouched
    },
  );

  it("M-9: the SAME deviceId pseudonymizes stably across event types (same salt)", () => {
    const realDeviceId = "ffff1111-2222-7333-8444-555555555555";
    const started = pseudonymizePayload("playback.started", { deviceId: realDeviceId, sessionId: "s1", itemId: "i1" }, opts());
    const ended = pseudonymizePayload("playback.ended", { deviceId: realDeviceId, sessionId: "s1", itemId: "i1" }, opts());
    expect(started.deviceId).toBe(ended.deviceId);
  });
});
