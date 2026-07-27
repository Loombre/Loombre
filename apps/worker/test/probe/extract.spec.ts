// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractMediaInfo } from "../../src/probe/extract.js";
import { ProbeError } from "../../src/probe/errors.js";
import type { MediaInfo, RawProbeResult } from "../../src/probe/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "raw");

function loadRaw(name: string): RawProbeResult {
  const raw = readFileSync(join(FIXTURES_DIR, name), "utf8");
  return JSON.parse(raw) as RawProbeResult;
}

describe("extractMediaInfo — real ffprobe captures", () => {
  it("h264 High profile 8-bit + aac 2ch, mp4 (major_brand isom)", () => {
    const raw = loadRaw("01_h264_aac.json");
    const result = extractMediaInfo(raw, { sizeBytes: 103060, fileId: "file-01" });
    const expected: MediaInfo = {
      fileId: "file-01",
      container: "mp4",
      durationMs: 2000,
      sizeBytes: 103060,
      overallBitrateBps: 412240,
      video: [
        {
          index: 0,
          codec: "h264",
          profile: "high",
          level: 13,
          width: 320,
          height: 240,
          bitDepth: 8,
          frameRate: 25,
          bitrateBps: 270332,
          hdr: "none",
          dvProfile: null,
          dvBlCompatId: null,
          interlaced: false,
        },
      ],
      audio: [
        {
          index: 1,
          codec: "aac",
          channels: 2,
          sampleRate: 44100,
          bitrateBps: 127990,
          language: "eng",
          isDefault: true,
          hasAtmos: false,
        },
      ],
      subtitle: [],
    };
    expect(result).toStrictEqual(expected);
  });

  it("hevc Main10 10-bit + smpte2084 (HDR10), mkv, no audio", () => {
    const raw = loadRaw("02_hevc10_hdr10.json");
    const result = extractMediaInfo(raw, { sizeBytes: 128660, fileId: "file-02" });
    const expected: MediaInfo = {
      fileId: "file-02",
      container: "mkv",
      durationMs: 2000,
      sizeBytes: 128660,
      overallBitrateBps: 514640,
      video: [
        {
          index: 0,
          codec: "hevc",
          profile: "main10",
          level: 63,
          width: 640,
          height: 360,
          bitDepth: 10,
          frameRate: 24,
          bitrateBps: null,
          hdr: "hdr10",
          dvProfile: null,
          dvBlCompatId: null,
          interlaced: false,
        },
      ],
      audio: [],
      subtitle: [],
    };
    expect(result).toStrictEqual(expected);
  });

  it("hevc HLG (arib-std-b67), mkv", () => {
    const raw = loadRaw("15_hevc10_hlg.json");
    const result = extractMediaInfo(raw, { sizeBytes: 67239, fileId: "file-15" });
    expect(result.video[0]?.hdr).toBe("hlg");
    expect(result.container).toBe("mkv");
    expect(result).toStrictEqual({
      fileId: "file-15",
      container: "mkv",
      durationMs: 1000,
      sizeBytes: 67239,
      overallBitrateBps: 537912,
      video: [
        {
          index: 0,
          codec: "hevc",
          profile: "main10",
          level: 63,
          width: 640,
          height: 360,
          bitDepth: 10,
          frameRate: 24,
          bitrateBps: null,
          hdr: "hlg",
          dvProfile: null,
          dvBlCompatId: null,
          interlaced: false,
        },
      ],
      audio: [],
      subtitle: [],
    } satisfies MediaInfo);
  });

  it("mpeg2video Main profile, top-field-first interlaced, ts + 5.1 ac3", () => {
    const raw = loadRaw("06_mpeg2_interlaced_ac3.json");
    const result = extractMediaInfo(raw, { sizeBytes: 191948, fileId: "file-06" });
    const expected: MediaInfo = {
      fileId: "file-06",
      container: "ts",
      durationMs: 2020,
      sizeBytes: 191948,
      overallBitrateBps: 760144,
      video: [
        {
          index: 0,
          codec: "mpeg2",
          profile: "main",
          level: 8,
          width: 320,
          height: 240,
          bitDepth: 8,
          frameRate: 25,
          bitrateBps: null,
          hdr: "none",
          dvProfile: null,
          dvBlCompatId: null,
          interlaced: true,
        },
      ],
      audio: [
        {
          index: 1,
          codec: "ac3",
          channels: 6,
          sampleRate: 44100,
          bitrateBps: 192000,
          language: "eng",
          isDefault: false,
          hasAtmos: false,
        },
      ],
      subtitle: [],
    };
    expect(result).toStrictEqual(expected);
  });

  it("flac 5.1, raw .flac (no container metadata support -> no language/default)", () => {
    const raw = loadRaw("07_flac_5_1.json");
    const result = extractMediaInfo(raw, { sizeBytes: 152355, fileId: "file-07" });
    const expected: MediaInfo = {
      fileId: "file-07",
      container: "flac",
      durationMs: 2000,
      sizeBytes: 152355,
      overallBitrateBps: 609420,
      video: [],
      audio: [
        {
          index: 0,
          codec: "flac",
          channels: 6,
          sampleRate: 44100,
          bitrateBps: null,
          language: null,
          isDefault: false,
          hasAtmos: false,
        },
      ],
      subtitle: [],
    };
    expect(result).toStrictEqual(expected);
  });

  it("mp3, mono", () => {
    const raw = loadRaw("08_mp3.json");
    const result = extractMediaInfo(raw, { sizeBytes: 33084, fileId: "file-08" });
    const expected: MediaInfo = {
      fileId: "file-08",
      container: "mp3",
      durationMs: 2000,
      sizeBytes: 33084,
      overallBitrateBps: 132336,
      video: [],
      audio: [
        {
          index: 0,
          codec: "mp3",
          channels: 1,
          sampleRate: 44100,
          bitrateBps: 128000,
          language: null,
          isDefault: false,
          hasAtmos: false,
        },
      ],
      subtitle: [],
    };
    expect(result).toStrictEqual(expected);
  });

  it("webm vp9 Profile 0 + opus — container disambiguated by codec heuristic (no filenameHint)", () => {
    const raw = loadRaw("12_webm_vp9_opus.json");
    const result = extractMediaInfo(raw, { sizeBytes: 34160, fileId: "file-12" });
    const expected: MediaInfo = {
      fileId: "file-12",
      container: "webm",
      durationMs: 1008,
      sizeBytes: 34160,
      overallBitrateBps: 271111,
      video: [
        {
          index: 0,
          codec: "vp9",
          profile: "profile0",
          level: null, // ffprobe's -99 "unknown" sentinel
          width: 320,
          height: 240,
          bitDepth: 8,
          frameRate: 25,
          bitrateBps: null,
          hdr: "none",
          dvProfile: null,
          dvBlCompatId: null,
          interlaced: false,
        },
      ],
      audio: [
        {
          index: 1,
          codec: "opus",
          channels: 1,
          sampleRate: 48000,
          bitrateBps: null,
          language: null,
          isDefault: false,
          hasAtmos: false,
        },
      ],
      subtitle: [],
    };
    expect(result).toStrictEqual(expected);
  });

  it("m4a — mp4/mov/m4a family disambiguated by major_brand 'M4A '", () => {
    const raw = loadRaw("13_m4a.json");
    const result = extractMediaInfo(raw, { sizeBytes: 13453, fileId: "file-13" });
    expect(result.container).toBe("m4a");
    const expected: MediaInfo = {
      fileId: "file-13",
      container: "m4a",
      durationMs: 1000,
      sizeBytes: 13453,
      overallBitrateBps: 107624,
      video: [],
      audio: [
        {
          index: 0,
          codec: "aac",
          channels: 1,
          sampleRate: 44100,
          bitrateBps: 97464,
          language: null, // tags.language==='und' normalizes to null
          isDefault: true,
          hasAtmos: false,
        },
      ],
      subtitle: [],
    };
    expect(result).toStrictEqual(expected);
  });

  it("mov — mp4/mov/m4a family disambiguated by major_brand 'qt  '", () => {
    const raw = loadRaw("14_mov.json");
    const result = extractMediaInfo(raw, { sizeBytes: 47188, fileId: "file-14" });
    expect(result.container).toBe("mov");
    const expected: MediaInfo = {
      fileId: "file-14",
      container: "mov",
      durationMs: 1000,
      sizeBytes: 47188,
      overallBitrateBps: 377504,
      video: [
        {
          index: 0,
          codec: "h264",
          profile: "high",
          level: 13,
          width: 320,
          height: 240,
          bitDepth: 8,
          frameRate: 25,
          bitrateBps: 286952,
          hdr: "none",
          dvProfile: null,
          dvBlCompatId: null,
          interlaced: false,
        },
      ],
      audio: [
        {
          index: 1,
          codec: "aac",
          channels: 1,
          sampleRate: 44100,
          bitrateBps: 70303,
          language: null,
          isDefault: true,
          hasAtmos: false,
        },
      ],
      subtitle: [],
    };
    expect(result).toStrictEqual(expected);
  });

  it("missing bit_rate everywhere -> overallBitrateBps derived from sizeBytes*8/duration, stream bitrates null", () => {
    const raw = loadRaw("10_missing_bitrate.json");
    const result = extractMediaInfo(raw, { sizeBytes: 200000, fileId: "file-10" });
    expect(result.overallBitrateBps).toBe(800000); // 200000*8 / 2s
    expect(result.video[0]?.bitrateBps).toBeNull();
    expect(result.audio[0]?.bitrateBps).toBeNull();
    expect(result.container).toBe("mp4");
    expect(result.durationMs).toBe(2000);
  });
});

describe("extractMediaInfo — hand-authored (DV / Atmos / JOC / bitmap subtitles)", () => {
  it("hevc Dolby Vision profile 8, HDR10-compatible base layer (blCompat 1)", () => {
    const raw = loadRaw("03_hevc_dv8_blcompat1.json");
    const result = extractMediaInfo(raw, { sizeBytes: 4_000_000, fileId: "file-03" });
    expect(result.video[0]).toMatchObject({
      hdr: "dv",
      dvProfile: 8,
      dvBlCompatId: 1,
    });
    // hdr:'dv' must win over the underlying smpte2084 color_transfer.
    expect(result.video[0]?.hdr).not.toBe("hdr10");
  });

  it("hevc Dolby Vision profile 5, no compatible base layer", () => {
    const raw = loadRaw("03b_hevc_dv5.json");
    const result = extractMediaInfo(raw, { sizeBytes: 4_000_000, fileId: "file-03b" });
    expect(result.video[0]).toMatchObject({
      hdr: "dv",
      dvProfile: 5,
      dvBlCompatId: 0,
    });
  });

  it("TrueHD + Atmos, 7.1 core", () => {
    const raw = loadRaw("04_truehd_atmos.json");
    const result = extractMediaInfo(raw, { sizeBytes: 4_000_000, fileId: "file-04" });
    const expected: MediaInfo = {
      fileId: "file-04",
      container: "mkv",
      durationMs: 2000,
      sizeBytes: 4_000_000,
      overallBitrateBps: 6_000_000,
      video: [],
      audio: [
        {
          index: 0,
          codec: "truehd",
          channels: 8,
          sampleRate: 48000,
          bitrateBps: 6_000_000,
          language: "eng",
          isDefault: true,
          hasAtmos: true,
        },
      ],
      subtitle: [],
    };
    expect(result).toStrictEqual(expected);
  });

  it("E-AC-3 with Dolby Atmos (JOC), 5.1", () => {
    const raw = loadRaw("05_eac3_joc.json");
    const result = extractMediaInfo(raw, { sizeBytes: 4_000_000, fileId: "file-05" });
    const expected: MediaInfo = {
      fileId: "file-05",
      container: "ts",
      durationMs: 2000,
      sizeBytes: 4_000_000,
      overallBitrateBps: 768_000,
      video: [],
      audio: [
        {
          index: 0,
          codec: "eac3",
          channels: 6,
          sampleRate: 48000,
          bitrateBps: 768_000,
          language: "eng",
          isDefault: true,
          hasAtmos: true,
        },
      ],
      subtitle: [],
    };
    expect(result).toStrictEqual(expected);
  });

  it("plain E-AC-3 (no profile at all) is not flagged Atmos", () => {
    const raw = loadRaw("05_eac3_joc.json");
    raw.streams![0]!.profile = undefined;
    const result = extractMediaInfo(raw, { sizeBytes: 4_000_000, fileId: "file-05-plain" });
    expect(result.audio[0]?.hasAtmos).toBe(false);
    expect(result.audio[0]?.codec).toBe("eac3");
  });

  it("mixed subtitle set: subrip/ass/mov_text (real) + pgs/vobsub/dvbsub (hand-authored) + unknown fallback, plus real video/audio", () => {
    const raw = loadRaw("11_subtitle_set_mixed.json");
    const result = extractMediaInfo(raw, { sizeBytes: 500_000, fileId: "file-11" });
    const expected: MediaInfo = {
      fileId: "file-11",
      container: "mkv",
      durationMs: 2000,
      sizeBytes: 500_000,
      overallBitrateBps: 2_000_000,
      video: [
        {
          index: 0,
          codec: "h264",
          profile: "high",
          level: 13,
          width: 320,
          height: 240,
          bitDepth: 8,
          frameRate: 25,
          bitrateBps: 270332,
          hdr: "none",
          dvProfile: null,
          dvBlCompatId: null,
          interlaced: false,
        },
      ],
      audio: [
        {
          index: 1,
          codec: "aac",
          channels: 2,
          sampleRate: 44100,
          bitrateBps: 127990,
          language: "eng",
          isDefault: true,
          hasAtmos: false,
        },
      ],
      subtitle: [
        {
          index: 2,
          codec: "subrip",
          language: "eng",
          isForced: false,
          isDefault: true,
          isExternal: false,
          externalPath: null,
        },
        {
          index: 3,
          codec: "ass",
          language: "spa",
          isForced: true,
          isDefault: false,
          isExternal: false,
          externalPath: null,
        },
        {
          index: 4,
          codec: "mov_text",
          language: "fre",
          isForced: false,
          isDefault: true,
          isExternal: false,
          externalPath: null,
        },
        {
          index: 5,
          codec: "pgs",
          language: "jpn",
          isForced: false,
          isDefault: false,
          isExternal: false,
          externalPath: null,
        },
        {
          index: 6,
          codec: "vobsub",
          language: "ita",
          isForced: true,
          isDefault: false,
          isExternal: false,
          externalPath: null,
        },
        {
          index: 7,
          codec: "dvbsub",
          language: "deu",
          isForced: false,
          isDefault: false,
          isExternal: false,
          externalPath: null,
        },
        {
          index: 8,
          codec: "unknown",
          language: null,
          isForced: false,
          isDefault: false,
          isExternal: false,
          externalPath: null,
        },
      ],
    };
    expect(result).toStrictEqual(expected);
  });

  it("unknown video/audio codec fallback (prores/wmapro) + attachment/data streams skipped", () => {
    const raw = loadRaw("16_unknown_and_skipped.json");
    const result = extractMediaInfo(raw, { sizeBytes: 4_000_000, fileId: "file-16" });
    const expected: MediaInfo = {
      fileId: "file-16",
      container: "mkv",
      durationMs: 2000,
      sizeBytes: 4_000_000,
      overallBitrateBps: 16_000_000,
      video: [
        {
          index: 0,
          codec: "unknown",
          profile: "hq",
          level: null,
          width: 320,
          height: 240,
          bitDepth: 10,
          frameRate: 25,
          bitrateBps: 50_000_000,
          hdr: "none",
          dvProfile: null,
          dvBlCompatId: null,
          interlaced: false,
        },
      ],
      audio: [
        {
          index: 1,
          codec: "unknown",
          channels: 2,
          sampleRate: 44100,
          bitrateBps: 192000,
          language: null,
          isDefault: true,
          hasAtmos: false,
        },
      ],
      subtitle: [],
    };
    expect(result).toStrictEqual(expected);
    // exactly 2 streams survive out of 4 raw entries (attachment + data skipped)
    expect(result.video.length + result.audio.length + result.subtitle.length).toBe(2);
  });
});

describe("extractMediaInfo — container disambiguation edge cases", () => {
  it("filenameHint takes priority over the codec heuristic for matroska,webm", () => {
    // 12_webm_vp9_opus.json has webm-shaped codecs; force it to mkv by hint.
    const raw = loadRaw("12_webm_vp9_opus.json");
    const result = extractMediaInfo(raw, {
      sizeBytes: 1000,
      fileId: "hint-1",
      filenameHint: "/library/movie.mkv",
    });
    expect(result.container).toBe("mkv");
  });

  it("filenameHint forces webm even for non-webm-shaped codecs", () => {
    // 02_hevc10_hdr10.json is hevc — never webm-legal — but an explicit
    // .webm hint is still trusted over the heuristic.
    const raw = loadRaw("02_hevc10_hdr10.json");
    const result = extractMediaInfo(raw, {
      sizeBytes: 1000,
      fileId: "hint-2",
      filenameHint: "clip.webm",
    });
    expect(result.container).toBe("webm");
  });

  it("filenameHint disambiguates the mp4/mov/m4a family over major_brand", () => {
    const raw = loadRaw("13_m4a.json"); // major_brand M4A, would default to m4a
    const result = extractMediaInfo(raw, {
      sizeBytes: 1000,
      fileId: "hint-3",
      filenameHint: "clip.mp4",
    });
    expect(result.container).toBe("mp4");
  });

  it("mka extension hint maps to mkv (mkv-family, not webm)", () => {
    const raw = loadRaw("04_truehd_atmos.json");
    const result = extractMediaInfo(raw, {
      sizeBytes: 1000,
      fileId: "hint-4",
      filenameHint: "audio.mka",
    });
    expect(result.container).toBe("mkv");
  });

  it("throws a typed ProbeError for a format_name outside the closed Container union", () => {
    // 'wv' (WavPack) genuinely has no §2.1 Container member — it's in
    // EXCLUDED_MEDIA_EXTENSIONS (apps/worker/src/scan/parse/path-utils.ts,
    // STATE.md H3) for exactly this reason. NOTE: 'asf' used to be this
    // test's example format_name before H3 widened the Container union to
    // include it (wmv/wma both mux to 'asf' — see apps/worker/test/scan/
    // media-extensions.spec.ts's FORMAT_FACTS) — asf now resolves instead
    // of throwing, so it no longer fits this test's purpose.
    const raw: RawProbeResult = {
      streams: [],
      format: { format_name: "wv", duration: "1.0", size: "1", bit_rate: "8" },
    };
    expect(() => extractMediaInfo(raw, { sizeBytes: 1, fileId: "bad" })).toThrowError(ProbeError);
    try {
      extractMediaInfo(raw, { sizeBytes: 1, fileId: "bad" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProbeError);
      expect((err as ProbeError).code).toBe("unsupported-container");
    }
  });
});

describe("extractMediaInfo — determinism", () => {
  it("is a pure function: same input twice produces byte-identical output", () => {
    const raw = loadRaw("11_subtitle_set_mixed.json");
    const context = { sizeBytes: 500_000, fileId: "det-1" };
    const first = extractMediaInfo(raw, context);
    const second = extractMediaInfo(structuredClone(raw), { ...context });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("streams are ordered by ffprobe stream index regardless of input array order", () => {
    const raw = loadRaw("01_h264_aac.json");
    const reversed: RawProbeResult = { ...raw, streams: [...raw.streams!].reverse() };
    const result = extractMediaInfo(reversed, { sizeBytes: 103060, fileId: "order-1" });
    expect(result.video[0]?.index).toBe(0);
    expect(result.audio[0]?.index).toBe(1);
  });
});
