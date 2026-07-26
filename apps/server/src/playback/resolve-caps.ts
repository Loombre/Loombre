// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/resolve-caps.ts
//
// VerifiedCapabilities resolution for plan() (docs/PLAYBACK.md §2.5/§8,
// Phase 3 §11 step 6b deliverable 2): reads getCurrentVerifiedCapabilities()
// (the public @loombre/db barrel, P1.14 identity-reads precedent — see that
// function's own header) for the CURRENT platform (`os.platform()`).
//
// Fallback (BIND, reported): when no snapshot has EVER been recorded for
// this platform (fresh install — the worker's boot-time 'hwprobe' job
// hasn't completed yet, or never ran at all) OR the current platform isn't
// one hw-probing supports at all, this synthesizes a SOFTWARE-ONLY
// capability set (`{backend: 'software', decode: every VideoCodec, encode:
// ['h264','hevc'], toneMap: [], verifiedAtMs: 0}`) rather than crashing the
// request or handing plan() an EMPTY backends array (which would leave
// Stage G's rule (iii) — "full software, the unconditional last resort" —
// with literally nothing to fall back to, since that rule still reads
// `caps.backends.find(b => b.backend === 'software')`). `verifiedAtMs: 0`
// is the documented sentinel for "never actually verified" this step's
// instructions name — a REAL snapshot's timestamp is always > 0
// (Date.now()-based), so this can never collide with a genuine probe
// result. A boot warning (console.warn) fires exactly ONCE per process the
// first time this fallback is used, not per request — CLAUDE.md invariant
// 9 (Tier-0: request paths do no CPU-heavy work) doesn't apply to a single
// console.warn, but "warn on every request forever" would still be noisy
// log spam for an install that simply hasn't run hwprobe yet; a boolean
// latch keeps it to one line.

import { platform } from "node:os";
import { getCurrentVerifiedCapabilities, type HwPlatform } from "@loombre/db";
import type { VerifiedCapabilities, VideoCodec } from "@loombre/playback-engine";
import type { LoombreDb } from "../common/db.provider.js";

const ALL_VIDEO_CODECS: VideoCodec[] = ["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4", "unknown"];

export function softwareOnlyFallbackCapabilities(): VerifiedCapabilities {
  return {
    backends: [
      {
        backend: "software",
        decode: [...ALL_VIDEO_CODECS],
        encode: ["h264", "hevc"],
        toneMap: [],
        verifiedAtMs: 0,
      },
    ],
  };
}

const SUPPORTED_HW_PLATFORMS: readonly string[] = ["darwin", "linux", "win32"];

let warnedOnce = false;

function warnFallbackOnce(message: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`playback: ${message} — using a synthesized software-only VerifiedCapabilities fallback`);
}

export async function resolveVerifiedCapabilities(db: LoombreDb): Promise<VerifiedCapabilities> {
  const currentPlatform = platform();
  if (!SUPPORTED_HW_PLATFORMS.includes(currentPlatform)) {
    warnFallbackOnce(`unsupported platform "${currentPlatform}" for hardware capability probing`);
    return softwareOnlyFallbackCapabilities();
  }

  const snapshot = await getCurrentVerifiedCapabilities(db, currentPlatform as HwPlatform);
  if (snapshot === null) {
    warnFallbackOnce("no hardware capability snapshot recorded yet (worker hwprobe has not run)");
    return softwareOnlyFallbackCapabilities();
  }
  // db's VerifiedCapabilityBackend types decode/encode/toneMap as plain
  // string[] (query/hwcaps.ts's own header: TEXT[]/CHECK-constrained, not
  // native PG enums) — every value is proven a member of the closed §2.5
  // sets at the DB layer (migrations/0011's CHECK constraints), so this
  // cast only narrows a type the runtime value already satisfies.
  return snapshot as unknown as VerifiedCapabilities;
}

/** Test-only reset for the "warn once" latch (module-level state would
 *  otherwise leak between test cases in the same process). */
export function _resetWarnedOnceForTests(): void {
  warnedOnce = false;
}
