// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/progress-report.ts
//
// PUT /progress/{itemId} sender used by the HeartbeatScheduler (lib/
// heartbeat.ts). Two paths:
//   - normal ticks/pause/seek: routed through apiPut (reactive-401 retry,
//     matches every other authenticated call in this app).
//   - page unload: apiPut's retry-on-401 + async fetch can be cut off by
//     the browser mid-navigation. `navigator.sendBeacon` can't carry a
//     Bearer header (progress is auth-required), so this uses
//     `fetch(url, { keepalive: true })` instead — Chrome/Firefox/Safari all
//     keep a keepalive fetch alive past document teardown the same way
//     sendBeacon does, and it's the only option that can still set
//     Authorization.

import { getAuthStore } from "./auth-store.js";
import { buildProgressBody } from "./progress-body.js";
import type { HeartbeatSnapshot } from "./heartbeat.js";

export interface ProgressReportOptions {
  serverUrl: string;
  itemId: string;
  sessionId?: string;
}

/** Reliable best-effort send for page unload (`keepalive: true`); never
 *  throws (there is nothing left to catch it on unload). Fire-and-forget by
 *  design — the caller does not (and cannot reliably) await this. */
export function reportProgressOnUnload(options: ProgressReportOptions, snapshot: HeartbeatSnapshot): void {
  const state = getAuthStore().getSnapshot();
  if (!state.accessToken) return;
  const url = `${options.serverUrl.replace(/\/$/, "")}/progress/${encodeURIComponent(options.itemId)}`;
  try {
    void fetch(url, {
      method: "PUT",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.accessToken}`,
      },
      body: JSON.stringify(buildProgressBody(snapshot, options.sessionId)),
    });
  } catch {
    // best-effort — nothing else to do at unload time.
  }
}
