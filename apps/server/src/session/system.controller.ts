// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/system.controller.ts
//
// GET /system/capabilities (public, task spec): real feature flags, not
// placeholders. `flags` is the compact "currently enabled" list; `details`
// documents every known CapabilityFlag (contract) with its enabled state.
// Only music/hls-ll/restricted-content are mandated by this wave's spec —
// the rest (hw-transcode/remote-access/data-export/data-import) are
// reported honestly as not-yet-implemented rather than hardcoded true
// (decision beyond spec, see task report).
//
// STATE.md P4.15 (Phase 4 lane G1's rate-limit sweep): this is a PUBLIC,
// UNAUTHENTICATED route (AuthGuard's PUBLIC_ROUTES) — the sweep explicitly
// names it. per-IP, generous ceiling (SurfaceRateLimiterService.capabilities,
// default 120/min): the handler itself is a cheap in-memory read (no DB,
// no I/O), so the limit exists purely for basic DoS-amplification hygiene
// on an unauthenticated surface, not because the work is expensive.

import { Controller, Get, UseFilters, UseGuards } from "@nestjs/common";
import { isRestrictedContentEnabled } from "../common/capabilities.js";
import { RateLimit, SurfaceRateLimitGuard } from "../common/rate-limit.guard.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { SettingsService } from "../settings/settings.service.js";

interface CapabilityDetail {
  enabled: boolean;
  description: string | null;
}

interface Capabilities {
  flags: string[];
  details: Record<string, CapabilityDetail>;
}

@Controller("system")
@UseFilters(RateLimitExceptionFilter)
export class SystemController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get("capabilities")
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("capabilities", "ip")
  getCapabilities(): Capabilities {
    const details: Record<string, CapabilityDetail> = {
      music: { enabled: true, description: "Music library support." },
      "restricted-content": {
        enabled: isRestrictedContentEnabled(this.settingsService),
        description: "Native adult/restricted-content gating (docs/PLAN.md §6.4). Off by default.",
      },
      "hls-ll": { enabled: false, description: "Low-latency HLS delivery. Not yet implemented." },
      "hw-transcode": { enabled: false, description: "Hardware-accelerated transcoding. Not yet implemented (Phase 3)." },
      "remote-access": { enabled: false, description: "Built-in ACME/remote exposure. Not yet implemented." },
      "data-export": { enabled: false, description: "Open-format data export. Not yet implemented." },
      "data-import": { enabled: false, description: "Open-format data import. Not yet implemented." },
    };

    const flags = Object.entries(details)
      .filter(([, detail]) => detail.enabled)
      .map(([flag]) => flag);

    return { flags, details };
  }
}
