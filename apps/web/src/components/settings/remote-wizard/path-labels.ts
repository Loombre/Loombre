// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/remote-wizard/path-labels.ts
//
// STATE.md "Loombre Remote ..." (R8, Batch-1 lane U1). Human-facing labels
// for the three frozen PathId values (packages/shared's wizard-state.ts,
// law) — one place so every wizard/management surface names a path
// identically instead of re-typing "Loombre Remote" / "Tunnel" / "Direct"
// at each call site.

import type { PathId } from "@loombre/shared/remote";

export const ALL_PATH_IDS: readonly PathId[] = ["remote", "tunnel", "direct"];

export const PATH_LABELS: Record<PathId, string> = {
  remote: "Loombre Remote",
  tunnel: "Tunnel",
  direct: "Direct",
};

export const PATH_SHORT_DESCRIPTIONS: Record<PathId, string> = {
  remote: "A private network built into Loombre. Install a small app on each device that needs access.",
  tunnel: "Cloudflare Tunnel. No open ports on your router, but Cloudflare sits in the connection path.",
  direct: "Your server, directly on the public internet, with its own domain and certificate.",
};
