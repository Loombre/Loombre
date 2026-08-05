// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/compute-backoff-ms.ts
//
// STATE.md RG7 (T2): full-jitter exponential backoff for connector-restart
// pacing — the SAME shape as apps/worker/src/plugin-delivery/backoff.ts's
// own computeBackoffMs (RG7 names that file as the pattern to follow),
// reimplemented locally rather than imported: apps/server never imports
// apps/worker code (separate deployable apps, no existing precedent — see
// resolve-cloudflared-binary.ts's own header for the identical reasoning
// applied to ffprobe.ts's resolveBinary).
//
// BASE_MS/MAX_MS are this lane's OWN unpinned choice (RG7 names the SHAPE
// of the backoff, not the numbers — plugin-delivery/constants.ts's own
// header describes its identical pair as "UNPINNED" for the same reason):
// 1s base / 60s cap, deliberately faster-recovering than plugin-delivery's
// 2s/300s pair — a lost REMOTE-ACCESS connector is a more time-sensitive
// outage for an admin than one delayed plugin-event delivery, so this
// restarts more eagerly while still capping well short of "retry every
// second forever".

const BASE_MS = 1_000;
const MAX_MS = 60_000;

/** `consecutiveFailures` of 0 means "not currently backing off" — mirrors
 *  plugin-delivery/backoff.ts's own computeBackoffMs contract exactly, so
 *  callers never need a special case for that input. */
export function computeBackoffMs(consecutiveFailures: number, random: () => number = Math.random): number {
  if (consecutiveFailures <= 0) return 0;
  const exponent = Math.min(consecutiveFailures - 1, 30); // guard against overflow at absurd counts
  const capped = Math.min(BASE_MS * 2 ** exponent, MAX_MS);
  // Full jitter (0..capped) avoids a run of failed connectors all retrying in lockstep.
  return Math.floor(capped * random());
}
