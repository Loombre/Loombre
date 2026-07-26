// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/hls-js-config.test.ts
//
// Covers the retry tuning (docs/PLAYBACK.md §9's 503 + `Retry-After: 1`)
// and the xhrSetup token-injection contract — including the hard
// requirement that the token is never logged. Never imports the real
// hls.js (this module deliberately doesn't either), so this exercises the
// exact same object shape VideoPlayer.tsx hands to `new Hls(...)`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHlsJsConfig } from "./hls-js-config.js";

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
