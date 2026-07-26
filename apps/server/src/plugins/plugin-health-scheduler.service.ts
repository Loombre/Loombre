// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/plugin-health-scheduler.service.ts
//
// M-8 fix wave (adversarial review): before this fix, `PluginHealthService
// .runHealthCheck` was ONLY ever called from `registerPlugin`/
// `reapprovePlugin`/the admin "Check for updates" route — grep confirmed
// no scheduler anywhere in apps/server or apps/worker. Combined with the
// OTHER half of M-8 (a non-2xx HTTP status not counting against the
// breaker, fixed in packages/plugin-host/src/call-plugin.ts +
// manifest-client.ts this same fix wave), a plugin that fast-fails every
// call, or has simply drifted unhealthy since its last admin-triggered
// check, could sit `enabled: true` indefinitely with nobody ever
// re-checking it. This service is the periodic re-check LD8's "N failures
// -> auto-disable" wording implies (failure-of-any-kind, not
// transport-only, and not "only when an admin happens to click").
//
// Deliberately simple (mirrors apps/server/src/common/update-check/
// update-check.service.ts's OWN setTimeout-then-setInterval shape, the
// established precedent for a background-timer NestJS service in this
// codebase): every enabled plugin gets `runHealthCheck` called against it
// once per tick, respecting that function's OWN existing timeout/breaker
// plumbing entirely — this service adds NO new timeout logic of its own,
// only the SCHEDULE. Per-plugin isolation via `Promise.allSettled` (one
// slow/hanging plugin's manifest+canary calls never block another
// plugin's check from completing) — the same posture
// apps/worker/src/plugin-delivery/delivery-loop.ts's `runOnce` already
// takes for delivery ticks. An overlap guard (`ticking`) prevents a slow
// tick from ever running concurrently with itself.
//
// STARTUP_DELAY_MS is generous (60s) specifically so the FULL test suite
// (which boots this exact module via AppModule in most e2e specs) never
// fires a real network call mid-test — the established
// UpdateCheckService precedent this file's header names uses the identical
// technique (10s there; 60s here because a plugin health check is
// per-PLUGIN real outbound HTTP, a materially larger blast radius than one
// update-manifest fetch) — every timer is `.unref()`'d so it never keeps a
// short-lived process alive on its own either way.

import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { listPlugins } from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import { PluginHealthService } from "./plugin-health.service.js";

/** Grace period before the FIRST automatic health-check sweep — see this
 *  file's header. */
const STARTUP_DELAY_MS = 60_000;

/** How often every currently-enabled plugin gets re-checked. UNPINNED (no
 *  rail/mission text names an exact number for this) — 5 minutes matches
 *  apps/worker/src/plugin-delivery/constants.ts's own
 *  LPP_DELIVERY_BACKOFF_MAX_MS ceiling, so a plugin's WORST-case
 *  re-check/backoff cadence is consistent whether the signal comes from
 *  this sweep or from a failing delivery tick. */
export const PLUGIN_HEALTH_CHECK_INTERVAL_MS = 5 * 60_000;

@Injectable()
export class PluginHealthSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private startupTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly dbProvider: DbProvider,
    private readonly healthService: PluginHealthService,
  ) {}

  onApplicationBootstrap(): void {
    this.startupTimer = setTimeout(() => {
      void this.runSweep();
      this.timer = setInterval(() => void this.runSweep(), PLUGIN_HEALTH_CHECK_INTERVAL_MS);
      this.timer.unref?.();
    }, STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
  }

  /** Test/ops seam: runs exactly one sweep across every CURRENTLY enabled
   *  plugin, resolving once every plugin's check has settled. Never
   *  rejects — a single plugin's thrown error is caught and logged, the
   *  same per-plugin isolation posture the delivery loop's own
   *  `runOnce` takes (a bug in this sweep, or in one plugin's check, must
   *  never stall or crash any other plugin's). */
  async runSweep(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const plugins = await listPlugins(this.dbProvider.db);
      const enabled = plugins.filter((p) => p.enabled);
      await Promise.allSettled(
        enabled.map(async (plugin) => {
          try {
            await this.healthService.runHealthCheck(plugin.id);
          } catch (err) {
            console.error(
              `plugin-health-scheduler: periodic health check for plugin "${plugin.id}" threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }),
      );
    } finally {
      this.ticking = false;
    }
  }
}
