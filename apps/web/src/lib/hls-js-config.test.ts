// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/hls-js-config.test.ts
//
// Covers the retry tuning (docs/PLAYBACK.md §9's 503 + `Retry-After: 1`)
// and the xhrSetup token-injection contract — including the hard
// requirement that the token is never logged. Never imports the real
// hls.js (this module deliberately doesn't either), so this exercises the
// exact same object shape VideoPlayer.tsx hands to `new Hls(...)`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHlsJsConfig, resolveStartLevel } from "./hls-js-config.js";

function fakeXhr(): { openCalls: Array<[string, string, boolean]>; open: (method: string, url: string, async: boolean) => void } {
  const openCalls: Array<[string, string, boolean]> = [];
  return {
    openCalls,
    open: (method: string, url: string, async: boolean) => {
      openCalls.push([method, url, async]);
    },
  };
}

describe("buildHlsJsConfig retry tuning", () => {
  const config = buildHlsJsConfig({ getToken: () => "unused", appendToken: (url) => url });

  it("uses linear backoff at exactly 1000ms for every policy's errorRetry (matches the server's constant Retry-After: 1)", () => {
    for (const policy of [config.manifestLoadPolicy, config.playlistLoadPolicy, config.fragLoadPolicy]) {
      expect(policy.default.errorRetry.backoff).toBe("linear");
      expect(policy.default.errorRetry.retryDelayMs).toBe(1000);
      expect(policy.default.errorRetry.maxRetryDelayMs).toBe(1000);
    }
  });

  it("bumps maxNumRetry modestly above hls.js's own per-policy defaults (1/2/6) for every policy", () => {
    expect(config.manifestLoadPolicy.default.errorRetry.maxNumRetry).toBeGreaterThan(1);
    expect(config.playlistLoadPolicy.default.errorRetry.maxNumRetry).toBeGreaterThan(2);
    expect(config.fragLoadPolicy.default.errorRetry.maxNumRetry).toBeGreaterThan(6);
  });

  it("gives the manifest policy enough maxTimeToFirstByteMs headroom over the server's up-to-8s blocking poll", () => {
    expect(config.manifestLoadPolicy.default.maxTimeToFirstByteMs).toBeGreaterThan(8000);
  });
});

describe("buildHlsJsConfig xhrSetup", () => {
  it("appends the current token to every request URL via the injected appendToken", async () => {
    const config = buildHlsJsConfig({
      getToken: () => "at-secret-123",
      appendToken: (url, token) => `${url}?token=${token}`,
    });
    const xhr = fakeXhr();
    await config.xhrSetup(xhr as unknown as XMLHttpRequest, "https://host/playback/sessions/s1/hls/run0/s000000.m4s");
    expect(xhr.openCalls).toHaveLength(1);
    expect(xhr.openCalls[0]).toEqual(["GET", "https://host/playback/sessions/s1/hls/run0/s000000.m4s?token=at-secret-123", true]);
  });

  it("re-derives the token on every call (a mid-session rotation is picked up on the very next request)", async () => {
    let current = "at-1";
    const config = buildHlsJsConfig({
      getToken: () => current,
      appendToken: (url, token) => `${url}?token=${token}`,
    });
    const xhr1 = fakeXhr();
    await config.xhrSetup(xhr1 as unknown as XMLHttpRequest, "https://host/hls/media.m3u8");
    expect(xhr1.openCalls[0]?.[1]).toContain("token=at-1");

    current = "at-2";
    const xhr2 = fakeXhr();
    await config.xhrSetup(xhr2 as unknown as XMLHttpRequest, "https://host/hls/media.m3u8");
    expect(xhr2.openCalls[0]?.[1]).toContain("token=at-2");
  });

  it("supports an async getToken (awaited before the request is opened)", async () => {
    const config = buildHlsJsConfig({
      getToken: () => Promise.resolve("at-async"),
      appendToken: (url, token) => `${url}?token=${token}`,
    });
    const xhr = fakeXhr();
    await config.xhrSetup(xhr as unknown as XMLHttpRequest, "https://host/hls/media.m3u8");
    expect(xhr.openCalls[0]?.[1]).toContain("token=at-async");
  });

  it("does nothing when no token is available (lets the request go through unmodified rather than throwing)", async () => {
    const config = buildHlsJsConfig({ getToken: () => null, appendToken: (url) => `${url}?SHOULD_NOT_APPEAR` });
    const xhr = fakeXhr();
    await config.xhrSetup(xhr as unknown as XMLHttpRequest, "https://host/hls/media.m3u8");
    expect(xhr.openCalls).toHaveLength(0);
  });
});

describe("buildHlsJsConfig xhrSetup — the token is NEVER logged", () => {
  const consoleMethods = ["log", "warn", "error", "info", "debug", "trace"] as const;
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    for (const method of consoleMethods) {
      spies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
    }
  });
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  it("never calls any console method while injecting the token", async () => {
    const config = buildHlsJsConfig({
      getToken: () => "at-must-not-be-logged",
      appendToken: (url, token) => `${url}?token=${token}`,
    });
    await config.xhrSetup(fakeXhr() as unknown as XMLHttpRequest, "https://host/hls/media.m3u8");

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Wave C2 (docs/PLAYBACK.md §9.1.5 rule 6 + §9.1.9): the two pins the
// multi-variant model requires on the client.
// ───────────────────────────────────────────────────────────────────────────

describe("buildHlsJsConfig startPosition pin (§9.1.5 rule 6)", () => {
  const base = { getToken: () => "t", appendToken: (u: string, t: string) => `${u}?token=${t}` };

  it("pins startPosition to the intended start rather than leaving hls.js's live-edge default", () => {
    // Dropping EXT-X-PLAYLIST-TYPE:EVENT (owner-decision V3) makes the
    // stream look LIVE, and hls.js's default `startPosition: -1` means
    // "start at the live edge". For this throttled server the live edge is
    // up to 10 segments (60 s) PAST the resume point — so the default
    // would land the viewer a minute ahead of where they asked to be.
    expect(buildHlsJsConfig({ ...base, startPositionSec: 612.5 }).startPosition).toBe(612.5);
  });

  it("defaults to 0, NEVER to -1 — 0 is the start of the stream, -1 is the live edge", () => {
    expect(buildHlsJsConfig(base).startPosition).toBe(0);
    expect(buildHlsJsConfig({ ...base, startPositionSec: 0 }).startPosition).toBe(0);
  });

  it("refuses a nonsensical resume point rather than passing it to hls.js", () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildHlsJsConfig({ ...base, startPositionSec: bad }).startPosition, String(bad)).toBe(0);
    }
  });

  it("sets NO liveMaxLatencyDuration* — nothing may yank a paused or seeking viewer forward", () => {
    const config = buildHlsJsConfig(base) as unknown as Record<string, unknown>;
    expect(Object.keys(config).filter((k) => k.startsWith("liveMaxLatency"))).toEqual([]);
    expect(Object.keys(config).filter((k) => k.startsWith("liveSyncDuration"))).toEqual([]);
  });
});

describe("resolveStartLevel (§9.1.9) — start on the rung the server is ALREADY encoding", () => {
  const rung = (videoBitrateBps: number, audioBitrateBps = 160_000) => ({
    heightPx: 0,
    videoBitrateBps,
    audioBitrateBps,
    codec: "h264" as const,
  });

  it("is the index of the TOP rung within hls.js's own ascending-bandwidth ordering", () => {
    // hls.js re-sorts the master's variants by bandwidth ASCENDING, so a
    // startLevel is an index into THAT order, not into plan.ladder's array
    // order. For a normal descending policy table the top rung therefore
    // lands last.
    expect(resolveStartLevel([rung(8_000_000, 384_000), rung(3_000_000), rung(800_000)])).toBe(2);
  });

  it("is computed against the sorted order even when the policy table is UNSORTED", () => {
    // The array-order index would be 1 here; hls.js's index is 2.
    expect(resolveStartLevel([rung(800_000), rung(8_000_000, 384_000), rung(3_000_000)])).toBe(2);
  });

  it("uses TOTAL bandwidth (video + audio) — that is what hls.js sorts on", () => {
    // Top by videoBitrateBps is the first rung; its audio is small enough
    // that the second rung outranks it on TOTAL bandwidth, which is the
    // number BANDWIDTH/AVERAGE-BANDWIDTH carry and the one hls.js orders
    // by. Pinning the array index here would start on the wrong variant.
    expect(resolveStartLevel([rung(1_000_000, 0), rung(900_000, 500_000)])).toBe(0);
  });

  it("a single-variant master pins level 0 (there is exactly one thing to start on)", () => {
    expect(resolveStartLevel([rung(5_000_000)])).toBe(0);
  });

  it("an EMPTY ladder yields -1 — hls.js's own 'let ABR decide', never a fabricated index", () => {
    expect(resolveStartLevel([])).toBe(-1);
  });

  it("buildHlsJsConfig passes it straight through, defaulting to -1 when unpinned", () => {
    const base = { getToken: () => "t", appendToken: (u: string) => u };
    expect(buildHlsJsConfig({ ...base, startLevel: 2 }).startLevel).toBe(2);
    expect(buildHlsJsConfig(base).startLevel).toBe(-1);
  });

  it("a clean start therefore performs ZERO handoffs", () => {
    // hls.js's default first-load bandwidth guess would pick a LOW level
    // and immediately switch up — and under §9.1 every switch is a full
    // pipeline handoff on the server. Starting on the rung the pipeline
    // is already encoding makes the common case free.
    const ladder = [rung(8_000_000, 384_000), rung(3_000_000), rung(800_000)];
    const config = buildHlsJsConfig({
      getToken: () => "t",
      appendToken: (u: string) => u,
      startLevel: resolveStartLevel(ladder),
    });
    expect(config.startLevel).toBe(ladder.length - 1);
  });
});

describe("buildHlsJsConfig forward-buffer caps (gap-F6)", () => {
  const config = buildHlsJsConfig({ getToken: () => "unused", appendToken: (url) => url });

  it("caps maxBufferLength/maxMaxBufferLength well inside the server's 120s live window", () => {
    // gap-F6: with NO caps, hls.js's defaults (30s growing toward
    // maxMaxBufferLength 600s) let ordinary forward-buffering probe
    // segments far ahead of what the worker has produced. The server's
    // demoted segment-GET seek trigger reads a far-enough-ahead GET as an
    // implicit seek and RESTARTS the run — on a short file this churned a
    // fresh, untouched session to run7 (QA 2026-08-20/21). The ceiling
    // must sit strictly inside the 120s retention/live window so ordinary
    // buffering can never look like an out-of-window jump.
    expect(config.maxBufferLength).toBe(30);
    expect(config.maxMaxBufferLength).toBe(90);
  });

  it("keeps the ceiling under the 120s live window (the relation, not just the literal)", () => {
    const liveWindowSec = 120; // worker SEGMENT_RETENTION_SEC
    expect(config.maxMaxBufferLength).toBeLessThan(liveWindowSec);
    expect(config.maxBufferLength).toBeLessThanOrEqual(config.maxMaxBufferLength);
  });
});
