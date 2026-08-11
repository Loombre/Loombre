// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/session-plan.ts
//
// Maps a @loombre/db PlaybackSessionRow (+ optionally its assembled
// MediaInfo) onto the contract's PlaybackSession schema. Phase 3 §11 step
// 6b: the Phase 2 `buildDirectPlayPlan()`/`PHASE2_ENGINE_VERSION` literal is
// GONE — every session's `plan` column now holds a REAL
// `@loombre/playback-engine` `plan()` output (+ its `selection` sidecar,
// packages/db/src/query/playback-sessions.ts's own module header) for
// EVERY decision, including direct-play; that same module already branches
// the row's initial `status` on `plan.decision`, unchanged by this step.

export interface ContractPlaybackSessionRow {
  id: string;
  userId: string;
  deviceId: string | null;
  itemId: string | null;
  plan: Record<string, unknown> | null;
  engineVersion: string | null;
  status: string;
  errorCode: string | null;
  startedAtMs: number;
  updatedAtMs: number;
}

/**
 * `manifestUrl` (docs/PLAYBACK.md §9/§9.1, contract PlaybackSession
 * schema): `null` for direct-play (bypasses HLS packaging entirely); the
 * relative HLS MASTER playlist URL for every other decision
 * (direct-stream/remux/transcode).
 *
 * Wave C2 / owner-decision V5 re-pointed this from `hls/media.m3u8` to
 * `hls/master.m3u8` — a VALUE-semantics change, not a schema one. Every
 * HLS session gets a master, ladder-empty ones included (they render a
 * single-variant master, §9.1.1), so the client has ONE path and no
 * branch: attach to `manifestUrl`, let hls.js discover the variants, and
 * every ABR switch reaches the server as a `v{K}` request with no new API
 * surface at all. The old media-playlist route is untouched and still
 * serves the same bytes at `v{K}/media.m3u8`.
 *
 * The master is additionally available IMMEDIATELY (§9.1.2 item 1 — it is
 * rendered from the stored plan and never 503s), where the media playlist
 * blocks up to 8s for the first segment. Derived from the row's OWN stored
 * `plan.decision` (not threaded through every call site separately), so
 * both session-create's response and every later GET automatically agree.
 */
export function playbackManifestUrl(sessionId: string, decision: string | undefined): string | null {
  if (decision === "direct-play" || decision === undefined) return null;
  return `/playback/sessions/${sessionId}/hls/master.m3u8`;
}

function decisionOf(plan: Record<string, unknown> | null): string | undefined {
  if (plan && typeof plan === "object" && "decision" in plan) {
    const decision = (plan as { decision?: unknown }).decision;
    return typeof decision === "string" ? decision : undefined;
  }
  return undefined;
}

/** `media`'s field is intentionally a straight passthrough of
 *  @loombre/db's AssembledMediaInfo, not a re-mapped object: media-info.ts
 *  documents that AssembledVideoStream/AssembledAudioStream/
 *  AssembledSubtitleStream mirror the contract's VideoStream/AudioStream/
 *  SubtitleStream field-for-field on purpose, so no adapter is needed —
 *  verified structurally by Ajv response validation in conformance tests. */
export function toContractPlaybackSession(
  row: ContractPlaybackSessionRow,
  media?: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: row.id,
    itemId: row.itemId,
    userId: row.userId,
    deviceId: row.deviceId,
    plan: row.plan,
    ...(media !== undefined ? { media } : {}),
    status: row.status,
    errorCode: row.errorCode,
    manifestUrl: playbackManifestUrl(row.id, decisionOf(row.plan)),
    createdAtMs: row.startedAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}
