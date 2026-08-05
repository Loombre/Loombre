// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/remote-tunnel-boot-resumer.service.ts
//
// STATE.md R4/RG7 (T2): "connector resumes on boot if tunnel state row
// says enabled". A ONE-SHOT resume, not a periodic sweep — byte-for-byte
// the same startTimer, `.unref()`'d, single-flight-guarded shape as
// apps/server/src/plugins/plugin-health-scheduler.service.ts and apps/
// server/src/remote/posture/remote-posture-regression.scheduler.ts (both
// documented as the established "background-timer NestJS service"
// precedent in this codebase) MINUS the recurring setInterval — this fires
// exactly once per process lifetime.
//
// STARTUP_DELAY_MS exists for the SAME reason those two services have one:
// apps/server/test/remote-tunnel.e2e.spec.ts (and every other e2e spec
// that boots the real AppModule) must never have this fire a real
// connector resume as a side effect of simply booting for a test — the
// delay outlives any single test file's runtime, and `.unref()` means it
// never keeps a short-lived process alive waiting for its own timer either
// way.
//
// resumeConnectorIfEnabled() itself (remote-tunnel.service.ts) never
// throws — this service's own try/catch is a second, redundant safety net
// (defense in depth, matching plugin-health-scheduler.service.ts's own
// per-tick isolation posture) in case a future change to that method ever
// drops its own guarantee.

import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { RemoteTunnelService } from "./remote-tunnel.service.js";

/** Grace period before the one-shot resume attempt — see this file's
 *  header. Matches plugin-health-scheduler.service.ts's own
 *  STARTUP_DELAY_MS exactly (same reasoning, same magnitude). */
export const REMOTE_TUNNEL_BOOT_RESUME_DELAY_MS = 60_000;

@Injectable()
export class RemoteTunnelBootResumerService implements OnApplicationBootstrap, OnModuleDestroy {
  private startupTimer: NodeJS.Timeout | null = null;
  private resumed = false;
  private stopped = false;

  constructor(private readonly remoteTunnelService: RemoteTunnelService) {}

  onApplicationBootstrap(): void {
    this.startupTimer = setTimeout(() => {
      void this.resumeOnce();
    }, REMOTE_TUNNEL_BOOT_RESUME_DELAY_MS);
    this.startupTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  /** Test/ops seam: runs the one-shot resume immediately, bypassing the
   *  startup delay. Idempotent — a second call is a no-op, matching this
   *  service's own "one-shot" contract (it is not a periodic sweep). */
  async resumeOnce(): Promise<void> {
    if (this.resumed || this.stopped) return;
    this.resumed = true;
    try {
      await this.remoteTunnelService.resumeConnectorIfEnabled();
    } catch (err) {
      console.error(`remote-tunnel-boot-resumer: resume sweep failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
