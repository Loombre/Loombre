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
import { MEDIA_EXTENSIONS } from "../../src/scan/parse/index.js";
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
 * express — extending that union is a spec change (docs/PLAYBACK.md) plus
 * new playback-engine matrix cases, so v1 keeps them out of the scanner
 * instead of ingesting content it can never play.
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
  webm: { formatName: "matroska,webm", container: "webm" },
  wmv: { formatName: "asf", container: null },
  mpg: { formatName: "mpeg", container: null },
  mpeg: { formatName: "mpeg", container: null },
  flv: { formatName: "flv", container: null },
  vob: { formatName: "mpeg", container: null },
  // audio
  flac: { formatName: "flac", container: "flac" },
  mp3: { formatName: "mp3", container: "mp3" },
  m4a: { formatName: "mov,mp4,m4a,3gp,3g2,mj2", container: "m4a" },
  ogg: { formatName: "ogg", container: "ogg" },
  oga: { formatName: "ogg", container: "ogg" },
  opus: { formatName: "ogg", container: "ogg" },
  wav: { formatName: "wav", container: "wav" },
  alac: { formatName: "mov,mp4,m4a,3gp,3g2,mj2", majorBrand: "M4A ", container: "m4a" },
  aac: { formatName: "aac", container: null },
  wma: { formatName: "asf", container: null },
  ape: { formatName: "ape", container: null },
  wv: { formatName: "wv", container: null },
  aiff: { formatName: "aiff", container: null },
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
});
