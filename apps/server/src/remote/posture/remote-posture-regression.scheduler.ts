// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/remote-posture-regression.scheduler.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7/RG4, S1 lane). Periodic
// re-evaluation of the posture card, diffed against the last-seen grade
// per check: a worsening grade emits `posture.regressed`, a recovering one
// emits `posture.recovered` (both admin-only outbox events, schemas frozen
// at Wave 0 — see packages/contract/event-schemas/posture.{regressed,
// recovered}.schema.json).
//
// TIMER SHAPE: byte-for-byte the same startTimer-then-setInterval,
// .unref()'d, single-flight (`ticking` overlap guard) discipline as
// apps/server/src/plugins/plugin-health-scheduler.service.ts — that file's
// own header is the canonical rationale for every piece of this shape
// (grace-period startup delay so the full test suite never fires real work
// mid-boot; per-tick isolation so one bad tick never wedges the next).
//
// ADJUDICATION BEYOND R/RG LAW, flagged in this lane's report: R7/RG4 name
// the regression MECHANISM (diff vs last grades -> event) but not a
// concrete interval. No settings key is added for it — same "UNPINNED, no
// rail/mission text names an exact number" call plugin-health-scheduler.ts
// itself made for its own interval; a NEW settings key felt like more
// ceremony than a background-hygiene interval warrants, and CLAUDE.md/RG15
// note migration numbers are reserved per-lane, not handed out ad hoc — S1
// has none reserved, so this also avoids needing one. POSTURE_REGRESSION_
// CHECK_INTERVAL_MS is exported so a future lane can promote it to a real
// setting without touching call sites, if that turns out to matter.
//
// STATE PERSISTENCE, S1's own call (flagged, per the task brief's explicit
// "your call: table or in-memory-with-recompute-on-boot" prompt): in-memory
// only, recomputed fresh on every boot. No migration number is reserved
// for S1 (DRIFT DECISION #2 reserves 0029-0032 for WG1/WG2/P1/T1 only), and
// the brief's own default lean ("prefer recompute-on-boot unless you find
// a hard reason") applies cleanly here — posture facts (cert expiry, rate
// limiter policy, stale-account count) are the kind of state that's cheap
// to recompute and does not need to survive a restart for correctness; the
// ONLY cost of recompute-on-boot is that a regression that happened in the
// instant before a restart and recovered before the NEXT tick after boot
// would go unreported (the first sweep after any boot always seeds the
// baseline silently, never diffs against nothing — see runSweep below).
// This is a real, narrow blind spot, explicitly logged rather than hidden.

import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { recordPostureRegressedEvent, recordPostureRecoveredEvent } from "@loombre/db";
import { GRADE_SEVERITY, nowMs as clockNowMs, type PostureCheckKey, type PostureGrade } from "@loombre/shared";
import { DbProvider } from "../../common/db.provider.js";
import { RemotePostureService } from "./remote-posture.service.js";

/** Grace period before the FIRST automatic sweep — mirrors
 *  plugin-health-scheduler.service.ts's STARTUP_DELAY_MS exactly, same
 *  reason: the full test suite boots this module via AppModule in most
 *  e2e specs, and must never do real work (DB reads, a TLS cert read) mid-
 *  test as a side effect of simply booting. */
export const POSTURE_REGRESSION_STARTUP_DELAY_MS = 60_000;

/** How often the posture card is re-evaluated in the background.
 *  UNPINNED — see this file's header ("ADJUDICATION BEYOND R/RG LAW").
 *  15 minutes: posture facts drift slowly (a certificate's renewal window
 *  is measured in days, not minutes), so this sits deliberately looser
 *  than plugin-health-scheduler's 5-minute cadence (that one watches
 *  actively-failing network calls; this one watches slow-moving
 *  configuration facts). */
export const POSTURE_REGRESSION_CHECK_INTERVAL_MS = 15 * 60_000;

@Injectable()
export class RemotePostureRegressionSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private startupTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  /** In-memory-only baseline (see this file's header, "STATE PERSISTENCE")
   *  — recomputed fresh every boot, never persisted. */
  private lastGrades = new Map<PostureCheckKey, PostureGrade>();

  constructor(
    private readonly dbProvider: DbProvider,
    private readonly postureService: RemotePostureService,
  ) {}

  onApplicationBootstrap(): void {
    this.startupTimer = setTimeout(() => {
      void this.runSweep();
      this.timer = setInterval(() => void this.runSweep(), POSTURE_REGRESSION_CHECK_INTERVAL_MS);
      this.timer.unref?.();
    }, POSTURE_REGRESSION_STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
  }

  /** Test/ops seam: runs exactly one sweep. Never rejects — a thrown error
   *  is caught and logged, the same per-tick isolation posture
   *  plugin-health-scheduler.service.ts's own runSweep takes (a bug in one
   *  sweep must never crash the process or wedge the next tick). */
  async runSweep(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const path = await this.postureService.resolveActivePath();
      const { card } = await this.postureService.evaluate(path);
      const evaluatedAtMs = clockNowMs();

      for (const check of card.checks) {
        const previous = this.lastGrades.get(check.checkKey);
        if (previous !== undefined && previous !== check.grade) {
          if (GRADE_SEVERITY[check.grade] > GRADE_SEVERITY[previous]) {
            await recordPostureRegressedEvent(this.dbProvider.db, {
              checkKey: check.checkKey,
              previousGrade: previous,
              newGrade: check.grade,
              regressedAtMs: evaluatedAtMs,
            });
          } else {
            await recordPostureRecoveredEvent(this.dbProvider.db, {
              checkKey: check.checkKey,
              previousGrade: previous,
              newGrade: check.grade,
              recoveredAtMs: evaluatedAtMs,
            });
          }
        }
        this.lastGrades.set(check.checkKey, check.grade);
      }

      // A check that's no longer applicable (the active path changed)
      // drops its baseline entirely — if it becomes applicable again
      // later, that's a fresh first-sighting (seeded silently, see the
      // header), never a stale diff against a grade from a different path.
      const currentKeys = new Set(card.checks.map((c) => c.checkKey));
      for (const key of [...this.lastGrades.keys()]) {
        if (!currentKeys.has(key)) this.lastGrades.delete(key);
      }
    } catch (err) {
      console.error(`remote-posture-regression: sweep failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }
}
