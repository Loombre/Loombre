// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/track-load-failure.test.ts
//
// browser-player-F10: the wording half of "a music track that won't load
// says so and skips". The behaviour half (try/catch + bounded skip) lives
// in components/music/MusicPlayerProvider.test.tsx.

import { describe, expect, it } from "vitest";
import { trackLoadFailureMessage } from "./track-load-failure.js";

describe("trackLoadFailureMessage", () => {
  it("names the track, the reason, and the skip", () => {
    expect(
      trackLoadFailureMessage({ title: "Low Water", reason: "The file for this track is missing.", hasNext: true }),
    ).toBe('Can\'t play "Low Water" — The file for this track is missing. Skipping to the next track.');
  });

  it("says the queue is out of tracks instead of promising a skip that can't happen", () => {
    expect(trackLoadFailureMessage({ title: "Low Water", reason: "Not Found", hasNext: false })).toBe(
      'Can\'t play "Low Water" — Not Found. Nothing else in the queue.',
    );
  });

  it("drops the reason clause entirely when nothing specific is known", () => {
    expect(trackLoadFailureMessage({ title: "Low Water", reason: null, hasNext: true })).toBe(
      'Can\'t play "Low Water". Skipping to the next track.',
    );
    expect(trackLoadFailureMessage({ title: "Low Water", reason: "   ", hasNext: true })).toBe(
      'Can\'t play "Low Water". Skipping to the next track.',
    );
    expect(trackLoadFailureMessage({ title: "Low Water", hasNext: true })).toBe(
      'Can\'t play "Low Water". Skipping to the next track.',
    );
  });

  it("never doubles the reason's own sentence punctuation", () => {
    expect(trackLoadFailureMessage({ title: "Low Water", reason: "Server is at capacity!", hasNext: false })).toBe(
      'Can\'t play "Low Water" — Server is at capacity. Nothing else in the queue.',
    );
  });

  it("falls back to a generic noun when the queue entry has no usable title", () => {
    expect(trackLoadFailureMessage({ title: "   ", reason: "Not Found", hasNext: true })).toBe(
      "Can't play this track — Not Found. Skipping to the next track.",
    );
  });
});
