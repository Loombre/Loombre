// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/progress-body.ts
//
// d3-a4 (verify/gap-F6, P2): the ONE body builder for every PUT /progress
// write. The contract's ProgressUpdate declares integer positionMs
// (minimum 0) and integer-or-null durationMs; element-derived values are
// FRACTIONAL by nature (an HLS element duration is the float sum of
// segment durations — observed live: 773347.5). The heartbeat/pause/seek
// send used to round positionMs but pass durationMs raw, so once a
// fractional duration was adopted EVERY in-session write was rejected 422
// ('durationMs must be an integer or null') and progress silently froze —
// only the unload keepalive path rounded both. Rounding lives here, at
// the source, shared by both paths (VideoPlayer's heartbeat send and
// lib/progress-report.ts's unload fetch).

import type { HeartbeatSnapshot, ProgressState } from "./heartbeat.js";

export interface ProgressUpdateBody {
  positionMs: number;
  durationMs: number | null;
  state: ProgressState;
  sessionId?: string;
}

export function buildProgressBody(snapshot: HeartbeatSnapshot, sessionId?: string): ProgressUpdateBody {
  const durationMs = snapshot.durationMs === null ? null : Math.round(snapshot.durationMs);
  const positionMs = Math.max(0, Math.round(snapshot.positionMs));
  return {
    // d4-a2.125 (A-core/d3-a4-adjacent): clamped to the ROUNDED duration —
    // at the EOF edge the source-axis tail extent runs past the ffprobe
    // duration (observed live: positionMs 7124766 persisted against
    // durationMs 7124493), and a progress row must never claim a position
    // after the item ends. No duration (null) means no end to clamp to.
    positionMs: durationMs === null ? positionMs : Math.min(positionMs, durationMs),
    durationMs,
    state: snapshot.state,
    ...(sessionId ? { sessionId } : {}),
  };
}
