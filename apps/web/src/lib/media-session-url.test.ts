// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/media-session-url.test.ts
//
// The pure token-URL builders (deliverable 6: "the token-URL builders for
// the three new URL kinds") — `useSessionFileUrl`/`useHlsManifestUrl` are
// hooks (DOM/timer-dependent) and covered by the browser E2E lane instead,
// per this step's "compile-true wiring + pure-logic coverage" scope.

import { describe, expect, it } from "vitest";
import { appendTokenParam, buildHlsManifestUrl, buildHlsSubtitleUrl, buildSessionFileUrl } from "./media-session-url.js";

describe("buildSessionFileUrl", () => {
  it("builds the direct-play file URL with ?token=", () => {
    expect(buildSessionFileUrl("http://localhost:3001", "session-1", "at-1")).toBe(
      "http://localhost:3001/playback/sessions/session-1/file?token=at-1",
    );
  });

  it("strips a trailing slash from serverUrl", () => {
    expect(buildSessionFileUrl("http://localhost:3001/", "session-1", "at-1")).toBe(
      "http://localhost:3001/playback/sessions/session-1/file?token=at-1",
    );
  });

  it("encodes a session id that needs it", () => {
    expect(buildSessionFileUrl("http://localhost:3001", "a b", "at-1")).toContain("/playback/sessions/a%20b/file");
  });
});

describe("buildHlsManifestUrl", () => {
  it("builds the hls/media.m3u8 URL with ?token=", () => {
    expect(buildHlsManifestUrl("http://localhost:3001", "session-1", "at-1")).toBe(
      "http://localhost:3001/playback/sessions/session-1/hls/media.m3u8?token=at-1",
    );
  });
});

describe("buildHlsSubtitleUrl", () => {
  it("builds the subtitles/sub0.vtt URL with ?token= (the filename is always literally sub0.vtt)", () => {
    expect(buildHlsSubtitleUrl("http://localhost:3001", "session-1", "at-1")).toBe(
      "http://localhost:3001/playback/sessions/session-1/subtitles/sub0.vtt?token=at-1",
    );
  });
});

describe("appendTokenParam", () => {
  it("adds ?token= to an absolute URL with no existing query string", () => {
    expect(appendTokenParam("https://host/playback/sessions/s1/hls/run0/s000000.m4s", "at-1")).toBe(
      "https://host/playback/sessions/s1/hls/run0/s000000.m4s?token=at-1",
    );
  });

  it("REPLACES an existing token param rather than duplicating it (a rotated token on a re-requested manifest URL)", () => {
    const result = appendTokenParam("https://host/playback/sessions/s1/hls/media.m3u8?token=stale", "fresh");
    expect(result).toBe("https://host/playback/sessions/s1/hls/media.m3u8?token=fresh");
  });

  it("preserves other query params already on the URL", () => {
    const result = appendTokenParam("https://host/hls/media.m3u8?foo=bar", "at-1");
    const url = new URL(result);
    expect(url.searchParams.get("foo")).toBe("bar");
    expect(url.searchParams.get("token")).toBe("at-1");
  });
});
