// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/seek-request.ts
//
// Parse-don't-validate for POST /playback/sessions/{id}/seek's body
// (contract SeekRequest, docs/PLAYBACK.md §9 V8) — same posture as
// plan-request.ts: hand-rolled, strict (additionalProperties: false is
// enforced, not assumed), every rejection carries a human-readable detail
// for the 422 problem body.
//
// `rungIndex` range-checks against the session's stored ladder — the
// §9.1.7 coincident pair only means anything against a real rung, and the
// contract says 422 for a rung the session never published. Ladder-empty
// sessions (direct-stream copy, audio-only) have no rungs to name at all.

export interface ParsedSeekRequest {
  targetMs: number;
  rungIndex?: number;
}

export type SeekRequestParseResult = { ok: true; value: ParsedSeekRequest } | { ok: false; detail: string };

const ALLOWED_KEYS = new Set(["targetMs", "rungIndex"]);

export function parseSeekRequestBody(raw: unknown, ladderLength: number): SeekRequestParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "Request body must be a JSON object." };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, detail: `Unknown property "${key}".` };
  }
  const { targetMs, rungIndex } = raw as { targetMs?: unknown; rungIndex?: unknown };
  if (typeof targetMs !== "number" || !Number.isSafeInteger(targetMs) || targetMs < 0) {
    return { ok: false, detail: "targetMs must be a non-negative integer of milliseconds." };
  }
  if (rungIndex === undefined) {
    return { ok: true, value: { targetMs } };
  }
  if (typeof rungIndex !== "number" || !Number.isSafeInteger(rungIndex) || rungIndex < 0) {
    return { ok: false, detail: "rungIndex must be a non-negative integer." };
  }
  if (ladderLength === 0) {
    return { ok: false, detail: "This session has no quality ladder; rungIndex does not apply." };
  }
  if (rungIndex >= ladderLength) {
    return { ok: false, detail: `rungIndex must name a rung of the session's ladder (0..${ladderLength - 1}).` };
  }
  return { ok: true, value: { targetMs, rungIndex } };
}
