// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/seek-target.ts
//
// The PLAYABLE ceiling for a seek-RESTART target (browser-player-F4, QA
// 2026-08-20/21 P1). clampSeekTargetMs (common/served-playlist.ts) bounds
// a requested target to [0, durationMs] — but durationMs ITSELF is not a
// playable restart target: an ffmpeg `-ss` at (or within a frame of) EOF
// spawns a run with essentially nothing displayable in it, the client's
// landing watch matches the near-empty run's PDT, and the element then
// waits forever for frames that never come — the EOF-seek wedge. A
// seek-restart target therefore backs off one nominal §9.1.5 segment
// before the probed duration, so the seek-spawned run always carries the
// file's real final frames: a seek to "the very end" lands on the last
// ~6 s and then ends cleanly (`ended` → progress state 'played').
//
// A clip shorter than one segment clamps to 0 — a restart from the top IS
// its final segment. An unprobed file (durationMs null/invalid) keeps the
// lower bound only, exactly like clampSeekTargetMs itself. Both write
// paths route here: the contract endpoint (sessions.controller.ts) and
// the segment-GET derived path (hls-file.controller.ts).

import { clampSeekTargetMs } from "../common/served-playlist.js";

/** SPF-1: kept at 6_000ms (three nominal 2s segments, not one nominal 6s
 *  segment) rather than re-derived from the new 2s nominal segment — this
 *  is the retained, QA-verified margin against an `-ss` landing inside the
 *  final GOP (browser-player-F4), and that hazard's size does not shrink
 *  just because the segment-duration constant did. */
export const EOF_SEEK_MARGIN_MS = 6_000;

/** `[0, max(0, durationMs − one nominal segment)]` — see the module
 *  header. Degrades exactly like clampSeekTargetMs when durationMs is
 *  unknown/invalid. */
export function clampSeekTargetToPlayableMs(targetMs: number, durationMs: number | null): number {
  const base = clampSeekTargetMs(targetMs, durationMs);
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return base;
  return Math.min(base, Math.max(0, Math.round(durationMs - EOF_SEEK_MARGIN_MS)));
}
