// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/update-check/update-check.service.ts
//
// The NestJS-facing wrapper around perform-check.ts's pure checker
// (STATE.md P4.3/P4.16). GET /system/update (apps/server/src/catalog/
// admin.controller.ts) calls `getUpdateInfo()` — this is the only class in
// the update-check/ directory that reads process.env / owns a real
// setInterval timer / calls the real global fetch; every decision RULE
// lives in perform-check.ts and is tested there without any of this.
//
// Mode behavior:
//   - "off":    getUpdateInfo() always returns the disabled shape
//               immediately — NEVER calls fetch, not even once, matching
//               STATE.md P4.16's "'off' fully disables incl. the admin
//               endpoint returning 'disabled'".
//   - "daily":  the first background check fires STARTUP_DELAY_MS after
//               boot (not synchronously in onApplicationBootstrap — a
//               short grace period so a slow/offline network never races
//               server startup, and so short-lived processes — the test
//               suite's own full-app boots included — never trigger a
//               real network call just by existing), then every 24h
//               (DAILY_CHECK_INTERVAL_MS); getUpdateInfo() serves the
//               in-memory cache (Tier-0 rule: the request path itself does
//               no network I/O) — if no check has landed yet (e.g. an
//               admin opens the update panel inside the startup grace
//               window), it awaits one on-demand rather than returning a
//               placeholder.
//   - "manual": no background timer; every getUpdateInfo() call performs
//               a fresh check (admin-triggered, infrequent by nature).
//
// Test suites that boot the full AppModule but never call GET /system/
// update are therefore never affected (the startup delay means nothing
// fires in their lifetime); apps/server/test/conformance.spec.ts DOES
// call every documented operation including this one, so it sets
// LOOMBRE_UPDATE_CHECK=off in its own beforeAll for a deterministic,
// network-free result — see that file's header note.
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration + hot-reload):
// `mode` now comes from SettingsService (packages/shared/src/
// settings-registry.ts's updateCheck.mode entry, still env-pinnable via
// LOOMBRE_UPDATE_CHECK, A8) instead of a raw process.env read captured once
// as a field initializer. S1 initially marked this requiresRestart:true
// (the old read site read env once at construction) — lane S3 flips it to
// requiresRestart:false in the SAME change: this service subscribes to
// SettingsService.onChange(), and a mode transition re-schedules (or tears
// down) the background timers exactly like the initial dispatch would on
// a fresh boot, so a mode change takes effect for the very next
// getUpdateInfo() call / background tick with no restart. manifestBaseUrl/
// channel/currentVersion/publicKeyText are unaffected by this migration —
// LOOMBRE_UPDATE_MANIFEST_URL is not an Addendum A registry entry (no A3/
// AD1 UI-editable key names it) and stays a plain env-only read.
//
// LIFECYCLE HAZARD (found + fixed by lane S3, worth recording in detail —
// this is the one case in this lane's migration where a WRONG transient
// value would have been externally observable, not just internally
// stale): Nest's DI container instantiates every provider's CONSTRUCTOR
// before ANY `OnApplicationBootstrap` hook runs anywhere in the app —
// including SettingsService's OWN `onApplicationBootstrap()`, which is
// what populates its cache. `onModuleInit()` ALSO runs strictly before
// `onApplicationBootstrap()` app-wide (verified empirically — see this
// lane's report), so scheduling the daily-check timer from `onModuleInit`
// (the ORIGINAL hook this class used) based on a mode resolved while the
// cache is still empty risks scheduling (or skipping) the FIRST real
// network check on a WRONG mode — unlike the rate limiters (a merely
// internally-stale value nobody can observe before app.listen()), an
// erroneously-scheduled 'daily' check when the real setting is 'off'
// would be a genuine one-time network call this instance's operator
// explicitly disabled. Fix: the constructor's `resolveMode()` stays
// defensive (never throws, falls back to the registry default 'daily')
// ONLY to give `this.config` a valid interim value; ALL scheduling now
// happens in `onApplicationBootstrap()` (renamed from `onModuleInit`),
// which re-resolves `mode` from the NOW-guaranteed-loaded cache before
// making any scheduling decision — SettingsService's own
// `onApplicationBootstrap()` is guaranteed to run first since this class
// depends on it.

import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { LOOMBRE_VERSION, LOOMBRE_UPDATE_PUBLIC_KEY_TEXT } from "@loombre/shared";
import { performUpdateCheck, type SystemUpdateInfo, type UpdateCheckConfig, type UpdateCheckDeps, type UpdateCheckMode } from "./perform-check.js";
import { resolveUpdateCheckConfig, DAILY_CHECK_INTERVAL_MS } from "./config.js";
import { SettingsService } from "../../settings/settings.service.js";

/** Grace period before the FIRST automatic daily check — see the file
 *  header's "daily" bullet. */
const STARTUP_DELAY_MS = 10_000;

@Injectable()
export class UpdateCheckService implements OnApplicationBootstrap, OnModuleDestroy {
  private config: UpdateCheckConfig;

  private readonly deps: UpdateCheckDeps = {
    fetchImpl: fetch.bind(globalThis),
    clockNowMs: () => Date.now(),
  };

  private cached: SystemUpdateInfo | null = null;
  private inFlight: Promise<SystemUpdateInfo> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly settingsService: SettingsService) {
    // LOOMBRE_UPDATE_CHECK is deliberately omitted here — resolveMode() (the
    // registry's effective value, below) is the single source for `mode`
    // from this point on; only manifestBaseUrl/channel/currentVersion/
    // publicKeyText come from this pure-config resolution.
    const base = resolveUpdateCheckConfig(
      { LOOMBRE_UPDATE_MANIFEST_URL: process.env["LOOMBRE_UPDATE_MANIFEST_URL"] },
      LOOMBRE_VERSION,
      LOOMBRE_UPDATE_PUBLIC_KEY_TEXT,
    );
    // Interim value only — never used to make a scheduling decision (see
    // this file's "LIFECYCLE HAZARD" header); onApplicationBootstrap()
    // re-resolves for real before scheduling anything.
    this.config = { ...base, mode: this.resolveMode() };
  }

  /** Never throws (see this file's "LIFECYCLE HAZARD" header) — falls back
   *  to the registry default 'daily' if SettingsService's cache isn't
   *  loaded yet, which is always true at construction time. */
  private resolveMode(): UpdateCheckMode {
    try {
      const effective = this.settingsService.getEffective("updateCheck.mode");
      return effective !== undefined ? (effective.value as UpdateCheckMode) : "daily";
    } catch {
      return "daily";
    }
  }

  onApplicationBootstrap(): void {
    // Re-resolve for real: SettingsService's own onApplicationBootstrap is
    // guaranteed to have already run (this class depends on it), so this
    // call cannot throw and reflects the true effective value.
    this.config = { ...this.config, mode: this.resolveMode() };
    this.scheduleForCurrentMode();
    this.unsubscribe = this.settingsService.onChange((event) => {
      if (event.key !== "updateCheck.mode") return;
      const nextMode = this.resolveMode();
      if (nextMode === this.config.mode) return;
      this.stopTimers();
      this.config = { ...this.config, mode: nextMode };
      this.cached = null;
      this.scheduleForCurrentMode();
    });
  }

  /** Starts the daily background timers when (and only when) the CURRENT
   *  mode is 'daily' — identical dispatch to what onApplicationBootstrap
   *  does unconditionally on boot, also called from the onChange handler
   *  above whenever a mode transition lands ON 'daily'. */
  private scheduleForCurrentMode(): void {
    if (this.config.mode !== "daily") return;
    this.startupTimer = setTimeout(() => {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), DAILY_CHECK_INTERVAL_MS);
      this.timer.unref?.();
    }, STARTUP_DELAY_MS);
    // Never keeps the process alive on its own (e.g. under a CLI/test
    // harness that expects a clean exit once its own work is done).
    this.startupTimer.unref?.();
  }

  private stopTimers(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
  }

  onModuleDestroy(): void {
    this.stopTimers();
    this.unsubscribe?.();
  }

  private async refresh(): Promise<SystemUpdateInfo> {
    if (this.inFlight) return this.inFlight;
    const promise = performUpdateCheck(this.config, this.deps).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = promise;
    const result = await promise;
    this.cached = result;
    return result;
  }

  async getUpdateInfo(): Promise<SystemUpdateInfo> {
    if (this.config.mode === "off") {
      // Never touches the network, never even constructs a URL — the
      // fastest, most literal reading of "fully disables".
      return performUpdateCheck(this.config, this.deps);
    }
    if (this.config.mode === "manual") {
      return this.refresh();
    }
    // daily
    if (this.cached) return this.cached;
    return this.refresh();
  }
}
