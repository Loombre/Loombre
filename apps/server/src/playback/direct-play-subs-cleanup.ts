// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/direct-play-subs-cleanup.ts
//
// Deliverable-6 BIND cleanup (STATE.md P3.9(e), Phase 3 §11 step 6b,
// reported prominently): a DIRECT-PLAY session carrying an hls-vtt
// subtitle side-track gets a staging directory
// (packages/db/src/internal/transcode-sessions.ts's ensureSessionStagingDir,
// written by the 'subtitle-extract' worker job) that NOTHING else will
// ever delete on disk — apps/worker/src/transcode/runner.ts only tears
// down `staging_dir` for sessions ITS state machine drives (any
// non-direct-play decision), and a direct-play session never enqueues a
// 'transcode' job at all (docs/PLAYBACK.md §9: "direct-play sessions
// bypass all of this"). Lane B is therefore the only remaining owner for
// exactly this one case — best-effort, non-fatal cleanup whenever a
// direct-play session that has a staging_dir ends, via either path that
// can end one: the DELETE endpoint (sessions.controller.ts) and the
// 15-minute idle-timeout sweeper (session-sweeper.service.ts). A
// non-direct-play session's staging_dir is deliberately left untouched
// here — that one is the worker's own to delete (never a double-delete
// race: rm force:true is idempotent either way, but the ownership split
// stays clean).

import { rm } from "node:fs/promises";

export interface EndedSessionForCleanup {
  plan: Record<string, unknown> | null;
  stagingDir: string | null;
}

export async function cleanupDirectPlaySubtitleStagingDir(session: EndedSessionForCleanup): Promise<void> {
  if (session.stagingDir === null) return;

  const decision =
    session.plan && typeof session.plan === "object" && "decision" in session.plan
      ? (session.plan as { decision?: unknown }).decision
      : undefined;
  if (decision !== "direct-play") return;

  await rm(session.stagingDir, { recursive: true, force: true }).catch(() => undefined);
}
