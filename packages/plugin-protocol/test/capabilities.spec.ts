// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/test/capabilities.spec.ts

import { describe, expect, it } from "vitest";
import {
  LppDetailsResponseSchema,
  LppEventBatchSchema,
  LppImagesResponseSchema,
  LppSearchRequestSchema,
  LppSearchResponseSchema,
  parseLppCapabilities,
  parseLppCapability,
} from "../src/capabilities/index.js";
import { eventSubscriberCapabilityFixture, metadataProviderCapabilityFixture } from "./fixtures.js";

describe("metadata-provider capability schema", () => {
  it("accepts the fixture capability", () => {
    expect(parseLppCapability(metadataProviderCapabilityFixture()).ok).toBe(true);
  });

  it("rejects an endpoint path that doesn't start with '/'", () => {
    const bad = { ...metadataProviderCapabilityFixture(), endpoints: { search: "provider/search", details: "/d", images: "/i" } };
    const result = parseLppCapability(bad);
    expect(result.ok).toBe(false);
  });

  // H-5 fix wave: `new URL(path, baseUrl)` resolves a leading `//` (and, in
  // some parsers, `/\`) as an AUTHORITY, not a path — the OLD `/^\//` regex
  // accepted `"//attacker.example/x"`, silently redirecting the call (with
  // X-LPP-Config/X-LPP-Secret-* headers) to an arbitrary third-party host,
  // with no scope-change signal (manifest-diff.ts treated endpoint-path
  // changes as non-scope-concerns before this fix wave).
  it("H-5: rejects a protocol-relative endpoint path ('//host/path')", () => {
    const bad = {
      ...metadataProviderCapabilityFixture(),
      endpoints: { search: "//attacker.example/collect", details: "/d", images: "/i" },
    };
    expect(parseLppCapability(bad).ok).toBe(false);
  });

  it("H-5: rejects a backslash-protocol-relative endpoint path ('/\\\\host/path')", () => {
    const bad = {
      ...metadataProviderCapabilityFixture(),
      endpoints: { search: "/\\attacker.example/collect", details: "/d", images: "/i" },
    };
    expect(parseLppCapability(bad).ok).toBe(false);
  });

  it("H-5: an ordinary single-leading-slash path is still accepted (the narrowing is precise, not a false-positive-prone regex)", () => {
    const ok = { ...metadataProviderCapabilityFixture(), endpoints: { search: "/lpp/provider/search", details: "/d", images: "/i" } };
    expect(parseLppCapability(ok).ok).toBe(true);
  });

  it("rejects an empty mediaKinds array", () => {
    const bad = { ...metadataProviderCapabilityFixture(), mediaKinds: [] };
    expect(parseLppCapability(bad).ok).toBe(false);
  });
});

describe("metadata-provider wire request/response schemas", () => {
  it("SearchRequest: accepts a minimal valid request", () => {
    expect(LppSearchRequestSchema.safeParse({ mediaKind: "movie", title: "Fixture" }).success).toBe(true);
  });

  it("SearchRequest: rejects an invalid mediaKind", () => {
    expect(LppSearchRequestSchema.safeParse({ mediaKind: "podcast", title: "x" }).success).toBe(false);
  });

  it("SearchResponse: accepts an empty results array", () => {
    expect(LppSearchResponseSchema.safeParse({ results: [] }).success).toBe(true);
  });

  it("SearchResponse: rejects a result missing 'ref'", () => {
    expect(LppSearchResponseSchema.safeParse({ results: [{ title: "x" }] }).success).toBe(false);
  });

  it("DetailsResponse: accepts every itemType variant with its type-specific fields", () => {
    const common = {
      title: "t",
      sortTitle: "t",
      year: 2001,
      overview: null,
      communityRating: null,
      contentRating: null,
      genres: [],
      tags: [],
      people: [],
      providerIds: {},
    };
    const variants = [
      { ...common, itemType: "movie", tagline: null, runtimeMs: null },
      { ...common, itemType: "series", status: null, airDateMs: null },
      { ...common, itemType: "season", seasonNumber: 1 },
      { ...common, itemType: "episode", seasonNumber: 1, episodeNumber: 1, airDateMs: null },
      { ...common, itemType: "artist" },
      { ...common, itemType: "album" },
      { ...common, itemType: "track", trackNumber: null, discNumber: null, durationMs: null },
    ];
    for (const details of variants) {
      const result = LppDetailsResponseSchema.safeParse({ details });
      expect(result.success, `${details.itemType}: ${JSON.stringify(!result.success && result.error.issues)}`).toBe(true);
    }
  });

  it("DetailsResponse: rejects a details object with an unrecognized itemType", () => {
    const result = LppDetailsResponseSchema.safeParse({ details: { itemType: "podcast-episode" } });
    expect(result.success).toBe(false);
  });

  it("ImagesResponse: accepts a well-formed image list", () => {
    const result = LppImagesResponseSchema.safeParse({
      images: [{ kind: "poster", url: "https://example.invalid/p.jpg" }],
    });
    expect(result.success).toBe(true);
  });

  it("ImagesResponse: rejects an invalid image kind", () => {
    const result = LppImagesResponseSchema.safeParse({ images: [{ kind: "banner", url: "https://example.invalid/p.jpg" }] });
    expect(result.success).toBe(false);
  });
});

describe("event-subscriber capability schema", () => {
  it("accepts the fixture capability", () => {
    expect(parseLppCapability(eventSubscriberCapabilityFixture()).ok).toBe(true);
  });

  it("rejects an empty eventTypes array", () => {
    const bad = { ...eventSubscriberCapabilityFixture(), eventTypes: [] };
    expect(parseLppCapability(bad).ok).toBe(false);
  });

  it("rejects a delivery endpoint that doesn't start with '/'", () => {
    const bad = { ...eventSubscriberCapabilityFixture(), delivery: { endpoint: "events" } };
    expect(parseLppCapability(bad).ok).toBe(false);
  });

  // H-5 fix wave — see the identical metadata-provider test above; the
  // event-subscriber capability's `delivery.endpoint` carries the SAME
  // risk (a protocol-relative path would ship a signed event batch,
  // potentially including restricted-content events for a
  // restricted-scoped subscriber, to an arbitrary third-party host).
  it("H-5: rejects a protocol-relative delivery endpoint ('//host/path')", () => {
    const bad = { ...eventSubscriberCapabilityFixture(), delivery: { endpoint: "//attacker.example/collect" } };
    expect(parseLppCapability(bad).ok).toBe(false);
  });

  it("H-5: rejects a backslash-protocol-relative delivery endpoint", () => {
    const bad = { ...eventSubscriberCapabilityFixture(), delivery: { endpoint: "/\\attacker.example/collect" } };
    expect(parseLppCapability(bad).ok).toBe(false);
  });
});

describe("event batch schema", () => {
  function batchFixture() {
    return {
      batchId: "0195f000-0000-7000-8000-000000000000",
      events: [
        {
          id: "0195f000-0000-7000-8000-000000000001",
          type: "item.added",
          occurredAtMs: 1_753_315_200_000,
          payload: { itemId: "abc" },
        },
      ],
      gapReport: null,
    };
  }

  it("accepts a well-formed batch with gapReport: null", () => {
    expect(LppEventBatchSchema.safeParse(batchFixture()).success).toBe(true);
  });

  it("accepts a well-formed batch with a populated gapReport", () => {
    const batch = {
      ...batchFixture(),
      gapReport: { detectedAtMs: 1_753_315_300_000, gaps: [{ fromMs: 1, toMs: 2, reason: "plugin unreachable" }] },
    };
    expect(LppEventBatchSchema.safeParse(batch).success).toBe(true);
  });

  it("rejects a batch missing gapReport entirely (must be present, nullable not optional)", () => {
    const fixture = batchFixture();
    const batch: Partial<typeof fixture> = { batchId: fixture.batchId, events: fixture.events };
    expect(LppEventBatchSchema.safeParse(batch).success).toBe(false);
  });

  it("rejects an empty events array", () => {
    expect(LppEventBatchSchema.safeParse({ ...batchFixture(), events: [] }).success).toBe(false);
  });

  it("rejects a malformed batchId", () => {
    expect(LppEventBatchSchema.safeParse({ ...batchFixture(), batchId: "not-a-uuid" }).success).toBe(false);
  });
});

describe("parseLppCapabilities", () => {
  it("separates unknown-type entries from valid ones and reports both", () => {
    const summary = parseLppCapabilities([
      metadataProviderCapabilityFixture(),
      { type: "future-capability", foo: "bar" },
      eventSubscriberCapabilityFixture(),
    ]);
    expect(summary.capabilities).toHaveLength(2);
    expect(summary.unknownTypes).toEqual(["future-capability"]);
    expect(summary.hasErrors).toBe(true);
    expect(summary.results.map((r) => r.ok)).toEqual([true, false, true]);
  });

  it("hasErrors is false and every entry parses when all capabilities are valid", () => {
    const summary = parseLppCapabilities([metadataProviderCapabilityFixture(), eventSubscriberCapabilityFixture()]);
    expect(summary.hasErrors).toBe(false);
    expect(summary.capabilities).toHaveLength(2);
    expect(summary.unknownTypes).toEqual([]);
  });

  it("deduplicates repeated unknown types", () => {
    const summary = parseLppCapabilities([{ type: "ghost" }, { type: "ghost" }]);
    expect(summary.unknownTypes).toEqual(["ghost"]);
  });
});
