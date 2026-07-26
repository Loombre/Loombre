// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/session-sweeper.service.ts
//
// Boot-registered ~60s interval (docs/PLAYBACK.md §9). TWO independent
// passes each tick:
//   1. 15-minute no-heartbeat cutoff -> END (unchanged since Phase 2,
//      P2.14) — listStalePlaybackSessions/endStalePlaybackSession, widened
//      by migrations/0012 (Phase 3 §11 step 6a) to also cover
//      starting/suspended/seeking, so a transcode session stuck in any of
//      those states is still reaped after 15 minutes.
//   2. Phase 3 §11 step 6b (this step's deliverable 5): 90s no-heartbeat
//      cutoff -> SUSPEND (not end), scoped to sessions still `active` —
//      listHeartbeatStalePlaybackSessions/suspendStalePlaybackSession
//      (packages/db/src/query/playback-sessions.ts's seam-contract
//      functions, already implemented by Lane A for exactly this call).
//      `suspended_by_throttle` stays false (the migration's heartbeat-cause
//      disambiguator, distinct from the worker's OWN segment-ahead
//      throttle suspend) — the worker's own reconciliation
//      (apps/worker/src/transcode/throttle.ts) reacts to `suspended`
//      regardless of which cause set it.
//
// Direct-play sessions carrying an hls-vtt subtitle staging dir (P3.9(e))
// are the ONE case Lane B must also clean up on the filesystem when a
// session ends via THIS path — see direct-play-subs-cleanup.ts's header.
//
// sweepOnce() is exported/public specifically so tests can invoke it
// directly (task spec: "fake timers OR direct invocation") without needing
// to fast-forward a real 60s interval.
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration): the two
// cutoffs (previously the fixed STALE_SESSION_CUTOFF_MS/
// HEARTBEAT_SUSPEND_CUTOFF_MS constants below, kept exported as their
// registry DEFAULTS for callers/tests that still want the historical
// numbers) now come from SettingsService (packages/shared/src/
// settings-registry.ts's sessions.staleCutoffMs/heartbeatSuspendCutoffMs
// entries), re-resolved at the START OF EVERY SWEEP TICK — the natural
// boundary for a periodic sweeper: a cutoff change is visible on the very
// next tick (requiresRestart:false), and because each tick re-reads
// server-authoritative session ROWS fresh anyway, there is no "mid-tick"
// state a changed cutoff could destabilize (unlike an in-flight admission
// or transcode session, a sweep tick has no notion of an in-progress unit
// of work that a cutoff change could interrupt).

import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
  endStalePlaybackSession,
  listHeartbeatStalePlaybackSessions,
  listStalePlaybackSessions,
  suspendStalePlaybackSession,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { DbProvider } from "../common/db.provider.js";
import { SettingsService } from "../settings/settings.service.js";
import { cleanupDirectPlaySubtitleStagingDir } from "./direct-play-subs-cleanup.js";

export const SWEEPER_TICK_MS = 60_000;
/** Registry default for sessions.staleCutoffMs (packages/shared/src/
 *  settings-registry.ts) — kept exported under its historical name for
 *  existing callers/tests; the LIVE value is always read from
 *  SettingsService at the start of each tick, see the header above. */
export const STALE_SESSION_CUTOFF_MS = 15 * 60_000;
/** Registry default for sessions.heartbeatSuspendCutoffMs — see
 *  STALE_SESSION_CUTOFF_MS's comment immediately above. */
export const HEARTBEAT_SUSPEND_CUTOFF_MS = 90_000;

@Injectable()
export class PlaybackSessionSweeperService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly dbProvider: DbProvider,
    private readonly settingsService: SettingsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.sweepOnce().catch((err: unknown) => {
        console.error("playback session sweeper tick failed:", err);
      });
    }, SWEEPER_TICK_MS);
    // Never keep the process alive solely for this timer (e.g. under tests
    // that boot the app without calling app.close(), or short-lived CLI
    // invocations).
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Ends every session past the 15-minute no-heartbeat cutoff (returning
   *  that count — tests assert on this directly, unchanged shape) AND
   *  suspends every still-`active` session past the 90s no-heartbeat
   *  cutoff (this step's new pass; no existing caller reads a count for
   *  it, so it isn't added to the return value). */
  async sweepOnce(nowMs: number = clockNowMs()): Promise<number> {
    const staleCutoffMs =
      (this.settingsService.getEffective("sessions.staleCutoffMs")?.value as number | undefined) ?? STALE_SESSION_CUTOFF_MS;
    const heartbeatSuspendCutoffMs =
      (this.settingsService.getEffective("sessions.heartbeatSuspendCutoffMs")?.value as number | undefined) ??
      HEARTBEAT_SUSPEND_CUTOFF_MS;

    const endCutoffMs = nowMs - staleCutoffMs;
    const stale = await listStalePlaybackSessions(this.dbProvider.db, endCutoffMs);
    for (const session of stale) {
      const ended = await endStalePlaybackSession(this.dbProvider.db, session.id, nowMs);
      if (ended) {
        await cleanupDirectPlaySubtitleStagingDir(ended);
      }
    }

    const suspendCutoffMs = nowMs - heartbeatSuspendCutoffMs;
    const heartbeatStale = await listHeartbeatStalePlaybackSessions(this.dbProvider.db, suspendCutoffMs);
    for (const session of heartbeatStale) {
      await suspendStalePlaybackSession(this.dbProvider.db, session.id, nowMs);
    }

    return stale.length;
  }
}
