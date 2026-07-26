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
 * `manifestUrl` (docs/PLAYBACK.md §9, contract PlaybackSession schema):
 * `null` for direct-play (bypasses HLS packaging entirely); the relative
 * HLS manifest URL for every other decision (direct-stream/remux/
 * transcode) — the worker may not have produced anything yet (the manifest
 * GET itself blocks/503s for that), but the URL is stable from
 * session-create time onward. Derived from the row's OWN stored
 * `plan.decision` (not threaded through every call site separately), so
 * both session-create's response and every later GET automatically agree.
 */
export function playbackManifestUrl(sessionId: string, decision: string | undefined): string | null {
  if (decision === "direct-play" || decision === undefined) return null;
  return `/playback/sessions/${sessionId}/hls/media.m3u8`;
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
