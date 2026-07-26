// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { isWellFormedManifest } from "../../../src/common/update-check/manifest-guard.js";

const VALID_MANIFEST = {
  manifestVersion: 1,
  channel: "stable",
  releases: [
    {
      version: "1.0.0",
      releasedAtMs: 1_753_315_200_000,
      notesUrl: "https://example.invalid/releases/1.0.0",
      artifacts: [],
    },
  ],
};

describe("isWellFormedManifest", () => {
  it("accepts a well-formed v1 stable manifest", () => {
    expect(isWellFormedManifest(VALID_MANIFEST)).toBe(true);
  });

  it("accepts an empty releases array", () => {
    expect(isWellFormedManifest({ ...VALID_MANIFEST, releases: [] })).toBe(true);
  });

  it.each([null, undefined, "a string", 42, [], true])("rejects non-object top level: %p", (value) => {
    expect(isWellFormedManifest(value)).toBe(false);
  });

  it("rejects the wrong manifestVersion", () => {
    expect(isWellFormedManifest({ ...VALID_MANIFEST, manifestVersion: 2 })).toBe(false);
    expect(isWellFormedManifest({ ...VALID_MANIFEST, manifestVersion: "1" })).toBe(false);
  });

  it("rejects an unknown channel", () => {
    expect(isWellFormedManifest({ ...VALID_MANIFEST, channel: "beta" })).toBe(false);
  });

  it("rejects a non-array releases field", () => {
    expect(isWellFormedManifest({ ...VALID_MANIFEST, releases: "nope" })).toBe(false);
  });

  it("rejects a release entry missing a required field", () => {
    const bad = { ...VALID_MANIFEST, releases: [{ version: "1.0.0", releasedAtMs: 1, artifacts: [] }] };
    expect(isWellFormedManifest(bad)).toBe(false);
  });

  it("rejects a release entry with the wrong field types", () => {
    const bad = {
      ...VALID_MANIFEST,
      releases: [{ version: "1.0.0", releasedAtMs: "not-a-number", notesUrl: "x", artifacts: [] }],
    };
    expect(isWellFormedManifest(bad)).toBe(false);
  });

  it("rejects a release entry whose artifacts isn't an array", () => {
    const bad = {
      ...VALID_MANIFEST,
      releases: [{ version: "1.0.0", releasedAtMs: 1, notesUrl: "x", artifacts: "nope" }],
    };
    expect(isWellFormedManifest(bad)).toBe(false);
  });
});
