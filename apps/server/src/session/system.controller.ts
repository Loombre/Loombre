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
import { loadTlsConfig } from "../tls/config.js";
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
      // GENUINELY not implemented: `lowLatency` exists only as a
      // device-profile INPUT field (what a client claims it supports).
      // Nothing here emits EXT-X-PART or holds parts back. Left as-is, and
      // its accuracy is the reason the rest of this map had to be fixed
      // one flag at a time rather than flipped wholesale.
      "hls-ll": { enabled: false, description: "Low-latency HLS delivery. Not yet implemented." },
      // IMPLEMENTED (apps/worker/src/hwcaps/args.ts emits real
      // `-hwaccel <backend>` / `-hwaccel_output_format` args, and
      // packages/db/src/query/hwcaps.ts stores the verified probe
      // snapshot). `enabled` stays false because this route is PUBLIC,
      // UNAUTHENTICATED and deliberately does zero I/O — reading the
      // snapshot would both add a DB query to an anonymous surface and
      // disclose the machine's video hardware to it. So this reports "not
      // confirmed available on this server", NOT "does not exist", and
      // points at the authenticated surface that has the real answer.
      "hw-transcode": {
        enabled: false,
        description:
          "Hardware-accelerated transcoding. Whether this machine has usable backends is reported under Settings > System, which requires an admin session.",
      },
      // IMPLEMENTED: LOOMBRE_TLS_MODE=acme is a first-class mode
      // (apps/server/src/tls/config.ts + tls/acme/, HTTP-01 and DNS-01).
      // loadTlsConfig is a pure function of env, so this stays a zero-I/O
      // read — no filesystem, no database — which is what let this flag
      // become truthful without changing the route's cost.
      "remote-access": {
        enabled: loadTlsConfig(process.env).mode === "acme",
        description:
          "Built-in ACME certificates for direct remote access (LOOMBRE_TLS_MODE=acme). Enabled only when this server manages its own certificates; 'manual' and 'off' report false.",
      },
      // IMPLEMENTED: exportData/importData in packages/contract/openapi.yaml,
      // served by apps/server/src/catalog/data-freedom.controller.ts. These
      // endpoints exist unconditionally, so the capability is simply true.
      "data-export": { enabled: true, description: "Open-format data export." },
      "data-import": { enabled: true, description: "Open-format data import." },
    };

    const flags = Object.entries(details)
      .filter(([, detail]) => detail.enabled)
      .map(([flag]) => flag);

    return { flags, details };
  }
}
