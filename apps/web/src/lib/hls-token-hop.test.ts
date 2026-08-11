// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/hls-token-hop.test.ts
//
// Wave C2 — THE SAFARI TOKEN-HOP VERIFICATION ITEM (docs/PLAYBACK.md
// §9.1.9, recorded by the spec as a build-phase verification item "not
// assumed").
//
// The item, verbatim: "The native path's empirically-verified token
// propagation must be RE-VERIFIED at build across the extra indirection hop
// (master -> variant playlist -> segments); if propagation does not cross
// the hop, the server renders variant URIs with the requesting token
// appended."
//
// WHAT THIS FILE CAN AND CANNOT ESTABLISH, stated up front because the
// honest scope IS the deliverable:
//
//   CAN (and does, below): the URL ARITHMETIC on both hops. Whether the
//   token survives is not a matter of URL semantics at all — standard
//   relative resolution DROPS a query string — so any propagation must come
//   from the media engine, and the two hops are arithmetically identical.
//   That equivalence is the load-bearing fact: master->variant and
//   playlist->segment are the same operation, so the mechanism Wave A
//   already verified empirically for the second hop is the same mechanism
//   the first hop needs.
//
//   CANNOT: run WebKit. jsdom has no HLS engine, no native `canPlayType`
//   for `application/vnd.apple.mpegurl`, and no network stack that would
//   issue the sub-requests. Whether Safari really propagates across TWO
//   hops is a browser-behaviour fact and belongs on the owner-verify
//   checklist, not in this suite.
//
// The conditional fallback (server-rendered token-bearing variant URIs) is
// therefore NOT implemented: the verification available here does not show
// propagation failing STRUCTURALLY — it shows the two hops are the same
// operation, which is the opposite conclusion. Implementing a fallback
// against an unverified suspicion would add a second auth-bearing URL shape
// (tokens embedded in a cached-by-nobody playlist body) for no established
// reason.

import { describe, expect, it } from "vitest";
import { appendTokenParam, buildHlsMasterUrl } from "./media-session-url.js";

const SERVER = "https://loombre.example";
const SESSION = "11111111-1111-4111-8111-111111111111";
const TOKEN = "at-token-hop";

describe("Safari native path: the master URL itself", () => {
  it("carries the token as a query parameter — the only auth channel `video.src` has", () => {
    const master = buildHlsMasterUrl(SERVER, SESSION, TOKEN);
    expect(new URL(master).pathname).toBe(`/playback/sessions/${SESSION}/hls/master.m3u8`);
    expect(new URL(master).searchParams.get("token")).toBe(TOKEN);
  });

  it("is the SAME route family the ?token= fallback already covered — no new auth surface", () => {
    // §9.1.9: "Token/retry policies: UNCHANGED, verbatim." The master is a
    // sibling of hls/media.m3u8 under the same controller and the same
    // @AllowQueryToken decorator.
    expect(new URL(buildHlsMasterUrl(SERVER, SESSION, TOKEN)).pathname).toMatch(
      /^\/playback\/sessions\/[0-9a-f-]+\/hls\/[a-z]+\.m3u8$/,
    );
  });
});

describe("the two hops are ARITHMETICALLY IDENTICAL (the verifiable half of the item)", () => {
  const master = buildHlsMasterUrl(SERVER, SESSION, TOKEN);

  it("hop 1 (master -> variant): relative resolution drops the query, exactly as hop 2 does", () => {
    // This is WHY the propagation question exists at all. If URL semantics
    // carried the query, no engine behaviour would be needed and the whole
    // item would be moot.
    const variant = new URL("v1/media.m3u8", master);
    expect(variant.pathname).toBe(`/playback/sessions/${SESSION}/hls/v1/media.m3u8`);
    expect(variant.searchParams.get("token")).toBeNull();
  });

  it("hop 2 (variant -> segment): the SAME drop, from the SAME operation", () => {
    const variant = new URL("v1/media.m3u8", master);
    const segment = new URL("run0/s000000.m4s", variant);
    expect(segment.pathname).toBe(`/playback/sessions/${SESSION}/hls/v1/run0/s000000.m4s`);
    expect(segment.searchParams.get("token")).toBeNull();
  });

  it("given hop 1 propagates, hop 2 composes: a query-bearing variant URL resolves to a query-bearing base", () => {
    // The structural argument the owner-verify checklist rests on. If the
    // engine appends the master's query to the variant request, the URL it
    // then resolves segments against IS query-bearing — which is precisely
    // the single-hop shape Wave A already verified empirically. Nothing in
    // the second hop is new.
    const variantWithToken = new URL(appendTokenParam(new URL("v1/media.m3u8", master).toString(), TOKEN));
    expect(variantWithToken.searchParams.get("token")).toBe(TOKEN);
    const segment = new URL("run0/s000000.m4s", variantWithToken);
    expect(segment.pathname).toBe(`/playback/sessions/${SESSION}/hls/v1/run0/s000000.m4s`);
  });

  it("the pre-C2 shape had exactly ONE such hop, and C2 adds a second of the same kind", () => {
    // Pre-C2: media.m3u8 -> run0/s000000.m4s. Post-C2: master.m3u8 ->
    // v1/media.m3u8 -> v1/run0/s000000.m4s. Same operation, one more time.
    const legacyPlaylist = new URL(`${SERVER}/playback/sessions/${SESSION}/hls/media.m3u8?token=${TOKEN}`);
    const legacySegment = new URL("run0/s000000.m4s", legacyPlaylist);
    expect(legacySegment.searchParams.get("token")).toBeNull();
    expect(legacySegment.pathname.endsWith("/hls/run0/s000000.m4s")).toBe(true);
  });
});

describe("the hls.js path needs none of this (the non-Safari half is settled)", () => {
  it("every request is re-tokenised at request time, whatever depth it sits at", () => {
    // `xhrSetup` runs for the master, for each variant playlist, and for
    // each `v{K}/`-prefixed segment — hls.js resolves them all to absolute
    // URLs before a loader sees them, and this rewrites each one.
    const master = buildHlsMasterUrl(SERVER, SESSION, TOKEN);
    const variant = new URL("v1/media.m3u8", master).toString();
    const segment = new URL("run0/s000000.m4s", new URL(variant)).toString();
    for (const url of [master, variant, segment]) {
      expect(new URL(appendTokenParam(url, "rotated-token")).searchParams.get("token")).toBe("rotated-token");
    }
  });

  it("a rotated token REPLACES the stale one rather than appending a second", () => {
    const master = buildHlsMasterUrl(SERVER, SESSION, TOKEN);
    const rotated = new URL(appendTokenParam(master, "rotated-token"));
    expect(rotated.searchParams.getAll("token")).toEqual(["rotated-token"]);
  });
});
