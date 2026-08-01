// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/plugin-delivery/actor-field-map.ts
//
// LPP v1 mission §3.2 (pseudonymization, default ON: "user-data
// minimization — pseudonymous actor ids by DEFAULT, per-plugin toggle for
// real identity"). An explicit per-event-type map of which top-level
// payload fields carry a real user id OR (M-9 fix wave) another stable,
// user-correlating identifier — built by reading every schema in
// packages/contract/event-schemas/* (apps/worker/test/plugin-delivery/
// actor-field-map.spec.ts re-derives this same inventory from the schema
// files at test time and asserts they match, so this map cannot silently
// drift from the real schemas as they evolve). An event type with NO
// correlating field has an EMPTY array here, not a missing entry —
// the exhaustiveness test distinguishes "verified, nothing to
// pseudonymize" from "nobody has looked at this type yet", the same
// distinction the repo's reasons-map exhaustiveness precedent
// (apps/web/src/lib/playback-reasons.test.ts) makes.
//
// All 23 envelope types are covered, including the 6 plugin.* types Lane
// W2 added (packages/contract/event-schemas/plugin.*.schema.json,
// envelope enum 15->21) and the 2 watchlist.* types Phosphor Wave 2 lane L3
// added (envelope enum 21->23): none of the six plugin.* types carry a
// user-id-bearing payload field — every plugin.* payload names only
// pluginId/name + plugin-specific facts (LD4/LD9: "NEVER carries the
// manifest ... or a secret"), never an acting admin's user id in the
// PAYLOAD itself (the envelope's own `actorUserId` field carries that, and
// is NOT part of what an LppEvent forwards — @loombre/plugin-protocol's
// LppEventSchema only crosses `payload` over the wire, never the
// envelope's actorUserId).

import { createHmac } from "node:crypto";

// M-9 fix wave: `playback.started`/`playback.progress`/`playback.ended`
// carry `deviceId` (stable per device, forever) and `sessionId` (stable per
// playback session) alongside `itemId` — neither is a real user id, so
// "real user ids provably absent by default" was already literally true
// without pseudonymizing them, but a subscriber granted these types could
// still build a durable, per-plugin-unlinkable-but-internally-consistent
// per-device viewing history purely from these correlators, which is
// exactly the kind of user-data minimization the mission's default-on
// pseudonymization posture is meant to close off. Extended with the SAME
// per-plugin salt/HMAC mechanism (stable, cross-plugin-unlinkable) rather
// than left as a residual, since the fix is no more than adding these two
// field names to the map below — `pseudonymizeUserId`/`pseudonymizePayload`
// are already field-name-agnostic (they pseudonymize WHATEVER string value
// sits at a mapped field, not specifically "a user id").
export const ACTOR_FIELD_MAP: Record<string, readonly string[]> = {
  "file.relocated": [],
  "item.added": [],
  "item.updated": [],
  "job.updated": [],
  "library.created": [],
  "playback.ended": ["deviceId", "sessionId"],
  "playback.progress": ["deviceId", "sessionId"],
  "playback.started": ["deviceId", "sessionId"],
  "progress.updated": ["userId"],
  "restricted.locked": ["userId"],
  "restricted.unlocked": ["userId"],
  "scan.completed": [],
  "scan.started": [],
  "settings.updated": ["actorUserId"],
  "user.created": ["userId"],
  // Phosphor Wave 2 lane L3: both carry {userId, itemId} — itemId is a
  // catalog item id (not user-correlating), userId is the acting user, same
  // mapping restricted.locked/unlocked already establish for a USER_ONLY_
  // TYPES payload shape.
  "watchlist.added": ["userId"],
  "watchlist.removed": ["userId"],
  "plugin.registered": [],
  "plugin.updated": [],
  "plugin.enabled": [],
  "plugin.disabled": [],
  "plugin.removed": [],
  "plugin.health-changed": [],
  // Phosphor retheme Wave 2 (Lane L2, Fix Match): itemId/jobId are not
  // user-correlating identifiers, and the type is ADMIN_ONLY (never
  // grantable to a plugin subscriber in the first place — see
  // event-taxonomy.ts) — empty for the same reason every plugin.* entry
  // above is, not left unmapped.
  "metadata.match-candidates": [],
  // H2 (owner brief): the CLI PIN-reset recovery event's payload DOES carry
  // a real userId (the reset's target user) — mapped for the same reason
  // settings.updated's actorUserId is mapped despite ALSO being ADMIN_ONLY
  // (this map tracks "does the schema carry a user-id-bearing field", not
  // "is this type reachable by a plugin today" — see this file's header).
  "user.restricted-pin-reset": ["userId"],
  // Owner ledger L1 (adjudication A-2): probe.failed's payload names only
  // {mediaFileId, libraryId, path, code} — none of them a user id or
  // another user-correlating identifier (USER_ID_FIELD_NAMES) — empty for
  // the same reason every plugin.* entry above is, not left unmapped. Also
  // ADMIN_ONLY (never grantable to a plugin subscriber in the first place
  // — see event-taxonomy.ts), same posture as metadata.match-candidates.
  "probe.failed": [],
  // STATE.md "Stash SQLite metadata sync", S3/K12: stash.provider.disabled's
  // payload names only {libraryId, seenVersion, supportedMin, supportedMax,
  // notice} — libraryId is a library id, not a user id or another
  // user-correlating identifier — empty for the same reason probe.failed's
  // entry is. Also ADMIN_ONLY (never grantable to a plugin subscriber in
  // the first place — see event-taxonomy.ts), same posture as probe.failed.
  "stash.provider.disabled": [],
  // STATE.md "Stash SQLite metadata sync", S8/K12 (Lane C sync engine):
  // stash.sync.started's {jobId, libraryId, mode, startedAtMs} and
  // stash.sync.completed's {jobId, libraryId, mode, status, counts,
  // durationMs, completedAtMs} name only job/library ids and sync
  // bookkeeping — no user id or another user-correlating identifier —
  // empty for the same reason stash.provider.disabled's entry is. Also
  // ADMIN_ONLY, same posture.
  "stash.sync.started": [],
  "stash.sync.completed": [],
};

/**
 * hex hmac-sha256(salt, realUserId) — LPP v1 mission §3.2's exact formula.
 * `salt` is the HMAC key, `realUserId` the message (packages/db/src/query/
 * plugins-delivery.ts#ensurePseudonymSalt mints/reads the per-plugin salt
 * this is called with). Stable for a given (salt, userId) pair — same
 * plugin, same user, same pseudonym across every batch (mission
 * "stability" requirement) — and cross-plugin-unlinkable because every
 * plugin has its own independently-random salt (mission "cross-plugin
 * unlinkability" requirement): two different plugins' salts produce two
 * unrelated pseudonyms for the SAME real user id.
 */
export function pseudonymizeUserId(salt: string, realUserId: string): string {
  return createHmac("sha256", salt).update(realUserId).digest("hex");
}

export interface PseudonymizeOptions {
  pseudonymizeActorIds: boolean;
  /** null only when pseudonymization is required but no salt has been
   *  minted yet — callers (delivery-loop.ts) are expected to call
   *  ensurePseudonymSalt() before building a batch whenever
   *  pseudonymizeActorIds is true, so this should not happen in practice.
   *  Handled defensively anyway: FAILS CLOSED (strips the field to null
   *  rather than ever letting a real id through unpseudonymized). */
  salt: string | null;
}

/**
 * Returns a NEW payload object with every field ACTOR_FIELD_MAP[type]
 * names replaced by its pseudonym, or the payload UNCHANGED (same
 * reference) when pseudonymization is off or the type has no mapped
 * fields — callers may rely on referential equality as a fast path signal
 * that nothing needed copying, but must never mutate either the input or
 * the returned object regardless.
 */
export function pseudonymizePayload(
  type: string,
  payload: Record<string, unknown>,
  opts: PseudonymizeOptions,
): Record<string, unknown> {
  if (!opts.pseudonymizeActorIds) return payload;
  const fields = ACTOR_FIELD_MAP[type];
  if (!fields || fields.length === 0) return payload;

  const result = { ...payload };
  for (const field of fields) {
    const value = result[field];
    if (typeof value !== "string") continue; // absent / null / already-not-a-string: leave as-is
    result[field] = opts.salt ? pseudonymizeUserId(opts.salt, value) : null; // fail closed, see PseudonymizeOptions.salt
  }
  return result;
}
