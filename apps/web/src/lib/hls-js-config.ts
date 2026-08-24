// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/hls-js-config.ts
//
// Phase 3 §11 step 6c: the hls.js config object VideoPlayer.tsx's dynamic
// import constructs `new Hls(buildHlsJsConfig(...))` with. Deliberately
// hls.js-import-FREE (only imports the `RetryConfig`/`LoaderConfig`-shaped
// object literals it returns, no `import "hls.js"` anywhere in this file)
// so it stays unit-testable — and tree-shakeable away from the browse
// route — without ever loading the real library.
//
// RETRY TUNING (docs/PLAYBACK.md §9's 503 + `Retry-After: 1` semantics —
// apps/server/src/playback/hls-file.controller.ts's manifest-not-ready,
// segment-not-ready, and subtitle-not-ready responses all set exactly this
// header): hls.js 1.6's config API is the modern `manifestLoadPolicy`/
// `playlistLoadPolicy`/`fragLoadPolicy` shape, NOT the deprecated flat
// `manifestLoadingMaxRetry`/`levelLoadingMaxRetry`/`fragLoadingMaxRetry`
// properties — verified against the installed hls.js@1.6.16: those flat
// properties are kept on `Hls.DefaultConfig` ONLY as a backwards-compat
// shim `mergeConfig()` reads to synthesize a `*LoadPolicy` object (dist/
// hls.js's `mergeConfig()`), and that shim has no way to set `backoff`,
// which this tuning needs (see below) — so this file sets the modern
// policy objects directly instead.
//
// Every policy's `errorRetry.retryDelayMs` is set to 1000ms with
// `backoff: 'linear'` (delay stays flat at 1000ms regardless of attempt
// count — hls.js's own `getRetryDelay()` computes
// `min(backoffFactor * retryDelayMs, maxRetryDelayMs)` with
// `backoffFactor = 1` under `'linear'`) to match the server's literal,
// constant `Retry-After: 1` — hls.js's default `backoff` is EXPONENTIAL
// (1s, 2s, 4s, 8s...), which overshoots a server that is always asking for
// exactly a 1s retry. `maxNumRetry` is bumped modestly (from hls.js's
// defaults of manifest=1/playlist=2/frag=6) to 8 across all three: a
// manifest 503 (worker still starting) or a segment 503 (seek-restart
// tearing down and respawning ffmpeg, apps/worker/src/transcode/index.ts)
// can legitimately take a few seconds to resolve, and giving up after only
// 1-2 seconds would surface spurious playback failures the server was
// always going to recover from a moment later.
//
// `timeoutRetry` (actual connection timeouts, not HTTP status codes) is
// left at hls.js's own defaults — unrelated to the 503/Retry-After
// contract this tuning targets.

export interface LoaderRetryConfig {
  maxNumRetry: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  backoff?: "linear" | "exponential";
}

export interface LoaderPolicyConfig {
  maxTimeToFirstByteMs: number;
  maxLoadTimeMs: number;
  timeoutRetry: LoaderRetryConfig;
  errorRetry: LoaderRetryConfig;
}

export interface LoadPolicyLike {
  default: LoaderPolicyConfig;
}

export interface HlsJsConfigLike {
  manifestLoadPolicy: LoadPolicyLike;
  playlistLoadPolicy: LoadPolicyLike;
  fragLoadPolicy: LoadPolicyLike;
  /** Seconds. See `HlsJsConfigOptions.startPositionSec`. */
  startPosition: number;
  /** Index into hls.js's own level list. See `resolveStartLevel`. */
  startLevel: number;
  /** Seconds of forward buffer hls.js targets. See the gap-F6 note on
   *  `FORWARD_BUFFER_TARGET_SEC`. */
  maxBufferLength: number;
  /** Seconds — the hard ceiling the target may grow to. See the gap-F6
   *  note on `FORWARD_BUFFER_CEILING_SEC`. */
  maxMaxBufferLength: number;
  xhrSetup: (xhr: XMLHttpRequest, url: string) => Promise<void>;
}

/** The shape `resolveStartLevel` needs out of a plan's ladder rung —
 *  declared structurally so this module keeps its no-dependency posture. */
export interface StartLevelRung {
  videoBitrateBps: number;
  audioBitrateBps: number;
}

/**
 * Which hls.js LEVEL corresponds to the rung the server's pipeline is
 * already encoding — the ladder's top rung (docs/PLAYBACK.md §9.1.9).
 *
 * WHY THIS IS NOT JUST AN ARRAY INDEX. The master playlist emits one
 * `EXT-X-STREAM-INF` per `plan.ladder[K]` in ARRAY order, but hls.js does
 * not preserve that order: it re-sorts the variants by BANDWIDTH ASCENDING
 * and `startLevel`/`nextLevel` index into THAT list. So the correct
 * `startLevel` is the top rung's position after the same sort, which for a
 * normal descending policy table is the LAST index — and for an unsorted
 * admin table is something else entirely. Pinning `K` directly would start
 * playback on a different variant than intended, and (because every switch
 * is a full server-side pipeline handoff) immediately pay for a handoff to
 * correct itself.
 *
 * Sorted on TOTAL bandwidth — video + audio — because that is the number
 * `BANDWIDTH`/`AVERAGE-BANDWIDTH` carry and therefore the one hls.js
 * orders by. The "top" rung is still the highest VIDEO bitrate, matching
 * `topRungOf` in the engine and the worker; the two coincide for every
 * shipped table but not by definition, and this function is where the
 * distinction is resolved rather than assumed.
 *
 * `-1` for an empty ladder — hls.js's own "let ABR decide". Never a
 * fabricated index.
 */
export function resolveStartLevel(ladder: readonly StartLevelRung[]): number {
  if (ladder.length === 0) return -1;
  let top = ladder[0]!;
  for (const rung of ladder) {
    if (rung.videoBitrateBps > top.videoBitrateBps) top = rung;
  }
  const bandwidth = (r: StartLevelRung): number => r.videoBitrateBps + r.audioBitrateBps;
  // Array.prototype.sort is stable in every engine this ships on, which
  // mirrors hls.js's own stable ordering for equal-bandwidth variants.
  const sorted = [...ladder].sort((a, b) => bandwidth(a) - bandwidth(b));
  return sorted.indexOf(top);
}

/**
 * FORWARD-BUFFER CAPS (gap-F6, QA 2026-08-20/21). hls.js's defaults are
 * `maxBufferLength: 30` growing toward `maxMaxBufferLength: 600` — ten
 * MINUTES of forward buffer. This server is not a CDN: the worker produces
 * segments just ahead of the viewer (segment-ahead throttle, docs/
 * PLAYBACK.md §9) and retention keeps only ~120s behind the live edge
 * (worker `SEGMENT_RETENTION_SEC`), and the DEMOTED segment-GET seek
 * trigger (apps/server/src/playback/hls-file.controller.ts) reads a GET
 * far enough ahead of `produced_segment` as an implicit seek and RESTARTS
 * the run. With no caps, ordinary forward-buffering on a short file could
 * probe far-ahead indices with ZERO user seeks involved — observed live as
 * a fresh, untouched session churning run0→run7, wedged at 0:00 with a
 * doubled duration label. The ceiling therefore sits strictly INSIDE the
 * 120s live window (90s = 15 six-second segments, well under the server's
 * out-of-window threshold), so nothing hls.js does on its own can ever
 * look like an out-of-window jump. The target stays at hls.js's own 30 —
 * pinned explicitly so a future hls.js default bump cannot silently
 * reopen the gap.
 */
const FORWARD_BUFFER_TARGET_SEC = 30;
const FORWARD_BUFFER_CEILING_SEC = 90;

/** Matches the server's constant `Retry-After: 1` (docs/PLAYBACK.md §9) —
 *  linear backoff at exactly this delay, never growing. */
const SERVER_RETRY_AFTER_MS = 1000;
/** Modest bump from hls.js's own per-policy defaults (1/2/6) — see header. */
const RETRY_MAX_ATTEMPTS = 8;

function linearErrorRetry(): LoaderRetryConfig {
  return {
    maxNumRetry: RETRY_MAX_ATTEMPTS,
    retryDelayMs: SERVER_RETRY_AFTER_MS,
    maxRetryDelayMs: SERVER_RETRY_AFTER_MS,
    backoff: "linear",
  };
}

export interface HlsJsConfigOptions {
  /** Called at the start of EVERY manifest/playlist/segment request (not
   *  just the first) so a token that rotates mid-playback (15-minute
   *  access-token lifetime, lib/auth-store.ts) is picked up on the very
   *  next request rather than requiring a full re-attach. May be async —
   *  hls.js awaits `xhrSetup`'s return value before sending the request. */
  getToken: () => string | null | Promise<string | null>;
  /** Rewrites a request URL to carry the current token — always
   *  `appendTokenParam` from lib/media-session-url.ts in real use; injected
   *  so this factory stays free of any URL-parsing duplication and easy to
   *  unit test with a trivial fake. */
  appendToken: (url: string, token: string) => string;
  /**
   * Wave C2 (docs/PLAYBACK.md §9.1.5 rule 6): where playback should START,
   * in seconds — the resume point, or 0.
   *
   * The multi-variant playlist model drops `EXT-X-PLAYLIST-TYPE:EVENT`
   * entirely (it contradicted the head-pruning retention already does), and
   * a type-less playlist reads as LIVE. hls.js's default `startPosition:
   * -1` then means "start at the live edge" — which for this server is
   * wherever the segment-ahead throttle has let the encoder get to, up to
   * 10 segments / 60 s past where the viewer asked to be. Pinning it is
   * therefore not a nicety; it is what keeps a resume landing on the resume
   * point. The existing `loadedmetadata` seek stays as belt-and-braces.
   */
  startPositionSec?: number;
  /**
   * Wave C2 (§9.1.9): which hls.js LEVEL to start on — use
   * `resolveStartLevel(plan.ladder)`. Pinning the rung the server's
   * pipeline is ALREADY encoding makes a clean start cost ZERO handoffs;
   * hls.js's default first-load bandwidth guess would otherwise pick a low
   * variant and immediately switch up, and under §9.1 every switch is a
   * full server-side pipeline restart. Top-surviving is network-safe by
   * construction — Stage F already dropped every rung above
   * `network.maxBitrateBps`.
   */
  startLevel?: number;
}

/** A resume point must be a real, non-negative number of seconds. Anything
 *  else (NaN from a bad parse, a negative from arithmetic, Infinity) is
 *  clamped to 0 rather than handed to hls.js — and 0 is deliberately not
 *  -1, which would mean "live edge", the exact thing this pin exists to
 *  avoid. */
function safeStartPosition(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return 0;
  return seconds;
}

/**
 * Builds the hls.js config object. `xhrSetup` NEVER logs (no `console.*`
 * call anywhere in this module) — the rewritten URL, which carries the
 * live access token in its query string, must never reach a log line.
 */
export function buildHlsJsConfig(options: HlsJsConfigOptions): HlsJsConfigLike {
  return {
    startPosition: safeStartPosition(options.startPositionSec),
    startLevel: options.startLevel ?? -1,
    maxBufferLength: FORWARD_BUFFER_TARGET_SEC,
    maxMaxBufferLength: FORWARD_BUFFER_CEILING_SEC,
    // Deliberately NO `liveMaxLatencyDuration`/`liveMaxLatencyDurationCount`
    // and no `liveSyncDuration*` (§9.1.5 rule 6): hls.js's defaults do no
    // forced live-edge chasing, and setting any of them would let the
    // player yank a paused or seeking viewer forward on a stream that only
    // LOOKS live.
    manifestLoadPolicy: {
      default: {
        // Generous: the manifest GET itself may legitimately block for up
        // to 8s server-side (docs/PLAYBACK.md §9's initial-segment poll)
        // before ever answering — this must comfortably exceed that, or
        // hls.js would time out a request the server was always going to
        // finish answering.
        maxTimeToFirstByteMs: 15_000,
        maxLoadTimeMs: 20_000,
        timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: linearErrorRetry(),
      },
    },
    playlistLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 10_000,
        maxLoadTimeMs: 20_000,
        timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: linearErrorRetry(),
      },
    },
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 10_000,
        maxLoadTimeMs: 120_000,
        timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: linearErrorRetry(),
      },
    },
    xhrSetup: async (xhr: XMLHttpRequest, url: string): Promise<void> => {
      const token = await options.getToken();
      if (!token) return; // no token yet (e.g. logged out mid-session) — let the request go through as-is and 401 normally.
      xhr.open("GET", options.appendToken(url, token), true);
    },
  };
}
