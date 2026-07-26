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
  xhrSetup: (xhr: XMLHttpRequest, url: string) => Promise<void>;
}

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
}

/**
 * Builds the hls.js config object. `xhrSetup` NEVER logs (no `console.*`
 * call anywhere in this module) — the rewritten URL, which carries the
 * live access token in its query string, must never reach a log line.
 */
export function buildHlsJsConfig(options: HlsJsConfigOptions): HlsJsConfigLike {
  return {
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
