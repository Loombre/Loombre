// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/media-extensions.spec.ts
//
// The scanner's admission set (src/scan/parse/path-utils.ts) and the probe
// pipeline's closed Container union (docs/PLAYBACK.md §2.1, resolved by
// src/probe/extract.ts's resolveContainer) must agree: an extension the
// scanner admits but probe cannot map produces a catalog_items/media_files
// row plus an item.added event, then fails probe with a DETERMINISTIC
// 'unsupported-container' error forever — a visible, permanently unplayable
// item. This suite pins the invariant in both directions so the two lists
// can never drift apart again. Pure (no DB, no ffmpeg): the ext ->
// format_name table below is the captured empirical fact.

import { describe, expect, it } from "vitest";
import { EXCLUDED_MEDIA_EXTENSIONS, MEDIA_EXTENSIONS } from "../../src/scan/parse/index.js";
import { extractMediaInfo } from "../../src/probe/extract.js";
import type { Container, RawProbeResult } from "../../src/probe/types.js";

interface FormatFact {
  /** `format.format_name` ffprobe reports for a real file with this extension. */
  formatName: string;
  /** `format.tags.major_brand`, when it is what disambiguates the mp4 family. */
  majorBrand?: string;
  /** Container resolveContainer yields, or null when it can only throw. */
  container: Container | null;
}

/**
 * Captured with ffmpeg/ffprobe 8.1.1 by muxing a real 1s file per extension
 * (`.alac` has no muxer of its own — ALAC is carried in an m4a, which is
 * what a real `.alac` file on disk is, and probes as the mp4 family; `.ape`
 * likewise has only a demuxer, whose name IS the reported format_name).
 * `container: null` marks the formats the §2.1 union genuinely cannot
 * express — v1.1 (STATE.md H3) widened the union to admit wmv/mpg/mpeg/
 * vob/flv/aac/aiff (see docs/PLAYBACK.md §2.1's widening note and apps/
 * worker/src/probe/extract.ts's SIMPLE_CONTAINER_MAP), so only ape/wv (and
 * wma — see below) remain genuinely unrepresentable. `container: null`
 * extensions are kept out of MEDIA_EXTENSIONS by the first test below; the
 * v1.1-reinstated ones are asserted admitted by the second.
 *
 * `wma` is a special case worth calling out: it shares .wmv's `asf`
 * format_name (verified empirically — ffmpeg's asf muxer reports the
 * identical format_name for an audio-only wmav2 stream as for a video wmv2
 * stream), so it is now technically REPRESENTABLE (`container: 'asf'`)
 * even though it stays OUT of MEDIA_EXTENSIONS in v1 — the exclusion is a
 * policy call (genuinely rare + thin codec support, EXCLUDED_MEDIA_
 * EXTENSIONS in apps/worker/src/scan/parse/path-utils.ts), not a technical
 * one. The scanner never enqueues a probe job for an excluded extension, so
 * this container/extension mismatch is inert in production; it is recorded
 * here only for factual accuracy of what resolveContainer actually does.
 */
const FORMAT_FACTS: Record<string, FormatFact> = {
  // video
  mkv: { formatName: "matroska,webm", container: "mkv" },
  mp4: { formatName: "mov,mp4,m4a,3gp,3g2,mj2", container: "mp4" },
  m4v: { formatName: "mov,mp4,m4a,3gp,3g2,mj2", container: "mp4" },
  mov: { formatName: "mov,mp4,m4a,3gp,3g2,mj2", container: "mov" },
  avi: { formatName: "avi", container: "avi" },
  ts: { formatName: "mpegts", container: "ts" },
  m2ts: { formatName: "mpegts", container: "ts" },
  // L1 (owner ledger): identical mpegts family as m2ts (verified
  // empirically — ffprobe reports the same format_name 'mpegts' for both
  // suffixes), now admitted alongside it (see path-utils.ts's VIDEO_
  // EXTENSIONS/EXCLUDED_MEDIA_EXTENSIONS header notes).
  mts: { formatName: "mpegts", container: "ts" },
  webm: { formatName: "matroska,webm", container: "webm" },
  wmv: { formatName: "asf", container: "asf" },
  mpg: { formatName: "mpeg", container: "mpeg" },
  mpeg: { formatName: "mpeg", container: "mpeg" },
  flv: { formatName: "flv", container: "flv" },
  vob: { formatName: "mpeg", container: "mpeg" },
  // audio
  flac: { formatName: "flac", container: "flac" },
  mp3: { formatName: "mp3", container: "mp3" },
  m4a: { formatName: "mov,mp4,m4a,3gp,3g2,mj2", container: "m4a" },
  ogg: { formatName: "ogg", container: "ogg" },
  oga: { formatName: "ogg", container: "ogg" },
  opus: { formatName: "ogg", container: "ogg" },
  wav: { formatName: "wav", container: "wav" },
  alac: { formatName: "mov,mp4,m4a,3gp,3g2,mj2", majorBrand: "M4A ", container: "m4a" },
  aac: { formatName: "aac", container: "aac" },
  // Technically representable (shares .wmv's 'asf' format_name — see header
  // note above) but stays excluded from MEDIA_EXTENSIONS for policy reasons.
  wma: { formatName: "asf", container: "asf" },
  ape: { formatName: "ape", container: null },
  wv: { formatName: "wv", container: null },
  aiff: { formatName: "aiff", container: "aiff" },
  // .aif is the common alias suffix for the same AIFF content — ffprobe
  // reports format_name 'aiff' regardless of suffix (verified empirically
  // against a pcm_s16be mux renamed to .aif; content-sniffed, not
  // extension-derived).
  aif: { formatName: "aiff", container: "aiff" },
};

function rawFor(fact: FormatFact): RawProbeResult {
  return {
    streams: [],
    format: {
      format_name: fact.formatName,
      duration: "1.000000",
      ...(fact.majorBrand ? { tags: { major_brand: fact.majorBrand } } : {}),
    },
  };
}

describe("scanner media extensions vs. the probe pipeline's Container union", () => {
  it("records an ffprobe format_name for every extension the scanner admits", () => {
    const missing = [...MEDIA_EXTENSIONS].filter((ext) => !(ext in FORMAT_FACTS));
    expect(missing).toEqual([]);
  });

  it("every admitted extension resolves to a Container instead of throwing", () => {
    for (const ext of MEDIA_EXTENSIONS) {
      const fact = FORMAT_FACTS[ext]!;
      expect(fact.container, `${ext} (format_name '${fact.formatName}') is not representable`).not.toBeNull();
      const info = extractMediaInfo(rawFor(fact), {
        sizeBytes: 1024,
        fileId: "file-ext",
        filenameHint: `sample.${ext}`,
      });
      expect(info.container).toBe(fact.container);
    }
  });

  it("keeps the unrepresentable containers out of the admission set", () => {
    const unrepresentable = Object.entries(FORMAT_FACTS)
      .filter(([, fact]) => fact.container === null)
      .map(([ext]) => ext);
    expect(unrepresentable.length).toBeGreaterThan(0);
    expect(unrepresentable.filter((ext) => MEDIA_EXTENSIONS.has(ext))).toEqual([]);
  });

  // --- v1.1 (STATE.md H3) ---------------------------------------------------

  it("admits the 7 v1.1-reinstated legacy extensions (wmv/mpg/mpeg/vob/flv/aac/aiff)", () => {
    for (const ext of ["wmv", "mpg", "mpeg", "vob", "flv", "aac", "aiff"]) {
      expect(MEDIA_EXTENSIONS.has(ext), ext).toBe(true);
    }
  });

  it("admits .mts alongside .m2ts (L1, owner ledger): identical mpegts family, zero-cost widening", () => {
    // .mts used to sit in EXCLUDED_MEDIA_EXTENSIONS purely for H3
    // brief-scope discipline (it enumerated the reinstated list exactly),
    // never for a technical reason — ffprobe reports the identical
    // 'mpegts' format_name for both suffixes (see FORMAT_FACTS above), so
    // there was never a representability gap to begin with. The owner
    // ledger closed that scope-discipline carve-out: .mts is admitted the
    // same as .m2ts now.
    expect(MEDIA_EXTENSIONS.has("mts")).toBe(true);
    expect(EXCLUDED_MEDIA_EXTENSIONS.has("mts")).toBe(false);
  });

  it("EXCLUDED_MEDIA_EXTENSIONS never overlaps MEDIA_EXTENSIONS, regardless of technical representability", () => {
    // wma is technically representable (container 'asf', shared with wmv —
    // see the FORMAT_FACTS header note) yet still must never be admitted:
    // the exclusion is a v1 policy call, not merely "probe would throw".
    expect(EXCLUDED_MEDIA_EXTENSIONS.has("wma")).toBe(true);
    expect(FORMAT_FACTS["wma"]!.container).not.toBeNull();
    for (const ext of EXCLUDED_MEDIA_EXTENSIONS) {
      expect(MEDIA_EXTENSIONS.has(ext), `${ext} must not be in MEDIA_EXTENSIONS`).toBe(false);
    }
    expect([...EXCLUDED_MEDIA_EXTENSIONS].sort()).toEqual(
      [
        // original v1 policy exclusions
        "ape",
        "wma",
        "wv",
        // recognized-media tail (Lane R review closed the silent class:
        // known-media-but-in-neither-set used to fall through to plain
        // "ignored" with no count, no list, no log). mts left this list
        // (L1, owner ledger) — see the dedicated admission test above.
        "3g2",
        "3gp",
        "ac3",
        "amr",
        "asf",
        "dff",
        "divx",
        "dsf",
        "dts",
        "dv",
        "f4v",
        "m2v",
        "m4b",
        "mka",
        "mpc",
        "ogv",
        "ra",
        "rm",
        "rmvb",
        "shn",
        "spx",
        "tta",
        "wtv",
      ].sort(),
    );
  });
});
