#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fixture generator for the probe pipeline's integration test
 * (apps/worker/test/probe/probe.integration.spec.ts) — docs/PLAYBACK.md
 * §8.1 ("bundled ffmpeg against generated lavfi testsrc2 inputs") / §10
 * ("checked in as a generator script, not binaries").
 *
 * Produces a small set of REAL, tiny (1-2 s, low-resolution) media files
 * under test-fixtures/media/ (gitignored — see .gitignore) using ffmpeg's
 * lavfi testsrc2/sine synthetic sources, plus a manifest.json describing
 * each file's expected typed properties for the integration test to assert
 * against.
 *
 * ffmpeg resolution mirrors apps/worker/src/probe/ffprobe.ts's
 * resolveFfmpeg() (LOOMBRE_FFMPEG env var, else a PATH lookup for
 * 'ffmpeg'), inlined here on purpose: this script is a standalone
 * repo-root tool (scripts/), not part of the @loombre/worker package, and
 * has zero dependencies on any workspace package by design (P1.9 spirit —
 * a missing ffmpeg is a clean, reportable skip, not an import-time crash
 * pulling in worker internals).
 *
 * Idempotent: skips (re-)encoding any output file that already exists,
 * unless run with --force. Missing ffmpeg or a missing feature-specific
 * encoder is a graceful skip with a clear console message — but (Phase 3
 * §11 step 1 extension) it is NEVER a silently-absent entry: every combo in
 * this script's generation targets gets recorded in manifest.json, either
 * under `files` (really generated, backed by a real file on disk) or under
 * `skipped` (not generated, with a `reason`). `probe.integration.spec.ts`
 * only ever reads `.files`, so this split is invisible to that consumer.
 *
 * docs/PLAYBACK.md §10 dimension-combination extension (STATE.md P3.9c):
 * beyond the original 8 baseline fixtures below, this script also generates
 * the full container×video-codec×bitDepth×hdr×interlaced grid, an
 * audio-codec×channel-count grid, embedded {srt,ass} subtitle tracks + an
 * external .srt sidecar, and (feature-detected) av1/truehd/dts extras.
 * Dolby Vision and PGS are recorded as skipped with reason
 * 'not-generatable-stock-ffmpeg' — stock ffmpeg cannot produce either; they
 * stay covered by the hand-authored probe fixtures under
 * apps/worker/test/probe/fixtures/raw/ instead.
 */

import { accessSync, constants as fsConstants, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const OUTPUT_DIR = join(REPO_ROOT, "test-fixtures", "media");
const FORCE = process.argv.includes("--force");

// ---------------------------------------------------------------------------
// ffmpeg resolution (inlined resolveFfmpeg() logic — see docstring above)
// ---------------------------------------------------------------------------

function isExecutableFile(candidate) {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name) {
  const pathEnv = process.env["PATH"] ?? process.env["Path"] ?? "";
  const dirs = pathEnv.split(delimiter).filter((d) => d.length > 0);
  const extensions =
    process.platform === "win32" ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function resolveFfmpeg() {
  const envPath = process.env["LOOMBRE_FFMPEG"];
  if (envPath) {
    if (isExecutableFile(envPath)) return { ok: true, path: envPath };
    return { ok: false, reason: `LOOMBRE_FFMPEG='${envPath}' is not an executable file` };
  }
  const found = findOnPath("ffmpeg");
  if (found) return { ok: true, path: found };
  return { ok: false, reason: "'ffmpeg' not found on PATH and LOOMBRE_FFMPEG is not set" };
}

// ---------------------------------------------------------------------------
// encoder feature detection
// ---------------------------------------------------------------------------

function listEncoders(ffmpegPath) {
  const out = execFileSync(ffmpegPath, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  const names = new Set();
  for (const line of out.split("\n")) {
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// encode helper
// ---------------------------------------------------------------------------

function run(ffmpegPath, args, label) {
  const result = spawnSync(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.warn(`[gen-media-fixtures] SKIP ${label}: ffmpeg exited ${result.status}\n${result.stderr ?? ""}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg.ok) {
    console.warn(`[gen-media-fixtures] SKIPPED: ${ffmpeg.reason}. Set LOOMBRE_FFMPEG or install ffmpeg to generate fixtures.`);
    // Still write an empty manifest so downstream consumers have a
    // predictable, parseable file to check for absence.
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(
      join(OUTPUT_DIR, "manifest.json"),
      JSON.stringify({ generatedAt: null, files: [], skipped: [] }, null, 2),
    );
    return;
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const encoders = listEncoders(ffmpeg.path);
  const manifestFiles = [];
  const manifestSkipped = [];

  const outPath = (name) => join(OUTPUT_DIR, name);

  function addEntry(entry) {
    manifestFiles.push(entry);
  }

  /** Records a not-generated combo — NEVER silently absent (see docstring). */
  function addSkipped(entry) {
    manifestSkipped.push(entry);
  }

  function encodeIfNeeded(fileName, args, expect, requiredEncoders = []) {
    const missing = requiredEncoders.filter((e) => !encoders.has(e));
    if (missing.length > 0) {
      const reason = `missing-encoder:${missing.join(",")}`;
      console.warn(`[gen-media-fixtures] SKIP ${fileName}: ${reason}`);
      addSkipped({ file: fileName, ...expect, skipped: true, reason });
      return;
    }
    const dest = outPath(fileName);
    if (!FORCE && existsSync(dest)) {
      addEntry({ file: fileName, ...expect, skipped: false });
      return;
    }
    const ok = run(ffmpeg.path, [...args, dest], fileName);
    if (ok) {
      addEntry({ file: fileName, ...expect, skipped: false });
    } else {
      // ffmpeg with -y truncates/creates the output before failing, so a
      // failed encode can leave a stale (often empty) file behind. Remove
      // it so a later idempotent re-run doesn't mistake it for a valid
      // cached fixture via the existsSync() short-circuit above.
      if (existsSync(dest)) rmSync(dest, { force: true });
      addSkipped({ file: fileName, ...expect, skipped: true, reason: "ffmpeg-exit-nonzero" });
    }
  }

  // mp4: h264 + aac
  encodeIfNeeded(
    "h264_aac.mp4",
    [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-movflags", "+faststart",
    ],
    { container: "mp4", videoCodec: "h264", audioCodec: "aac", channels: 2, interlaced: false },
    ["libx264", "aac"],
  );

  // mkv: h264 + aac + subrip
  encodeIfNeeded(
    "h264_aac_subrip.mkv",
    (() => {
      const srtPath = outPath("caption.srt");
      writeFileSync(srtPath, "1\n00:00:00,000 --> 00:00:01,000\nLoombre fixture\n");
      return [
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
        "-i", srtPath,
        "-c:v", "libx264", "-c:a", "aac", "-ac", "2", "-c:s", "subrip",
        "-metadata:s:s:0", "language=eng",
      ];
    })(),
    { container: "mkv", videoCodec: "h264", audioCodec: "aac", subtitleCodec: "subrip", channels: 2, interlaced: false },
    ["libx264", "aac", "subrip"],
  );

  // ts: mpeg2video interlaced + ac3
  encodeIfNeeded(
    "mpeg2_interlaced_ac3.ts",
    [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      // Top-field-first via the `setfield` FILTER, not the per-codec `-top 1`
      // option: newer ffmpeg builds (the Windows CI runner's among them) removed
      // `-top` as an encoding AVOption ("Codec AVOption top (top field first) is
      // not a encoding option"), so `-top 1` made ffmpeg exit nonzero and this
      // fixture got SKIPPED there — the interlace-detection tests then silently
      // fell through to the progressive h264 .ts and failed. setfield stamps
      // field_order=tt on every build; +ilme+ildct keeps mpeg2 in interlaced-
      // coding mode. (ffprobe reports field_order=tt identically under both.)
      "-vf", "setfield=mode=tff",
      "-c:v", "mpeg2video", "-flags", "+ilme+ildct",
      "-c:a", "ac3", "-b:a", "192k", "-ac", "2",
      "-f", "mpegts",
    ],
    { container: "ts", videoCodec: "mpeg2", audioCodec: "ac3", channels: 2, interlaced: true },
    ["mpeg2video", "ac3"],
  );

  // webm: vp9 + opus
  encodeIfNeeded(
    "vp9_opus.webm",
    [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      "-c:v", "libvpx-vp9", "-b:v", "200k", "-c:a", "libopus", "-ac", "2",
    ],
    { container: "webm", videoCodec: "vp9", audioCodec: "opus", channels: 2, interlaced: false },
    ["libvpx-vp9", "libopus"],
  );

  // flac
  encodeIfNeeded(
    "audio.flac",
    ["-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-c:a", "flac"],
    { container: "flac", audioCodec: "flac", channels: 1 },
    ["flac"],
  );

  // mp3 with ID3 tags
  encodeIfNeeded(
    "audio.mp3",
    [
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      "-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3",
      "-metadata", "title=Loombre fixture", "-metadata", "artist=gen-media-fixtures",
    ],
    { container: "mp3", audioCodec: "mp3", channels: 1 },
    ["libmp3lame"],
  );

  // m4a: aac
  encodeIfNeeded(
    "audio.m4a",
    ["-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-c:a", "aac", "-b:a", "96k"],
    { container: "m4a", audioCodec: "aac", channels: 1 },
    ["aac"],
  );

  // --- STATE.md H3: v1.1 legacy-format reinstatement baseline fixtures ---
  // (docs/PLAYBACK.md §2.1's widened Container union — asf/mpeg/flv/aac/
  // aiff). Empirically verified against real ffmpeg/ffprobe 8.1.1 before
  // this generator was extended (see apps/worker/test/scan/
  // media-extensions.spec.ts's FORMAT_FACTS table for the captured facts
  // this mirrors).

  // wmv: wmv2 + wmav2, asf muxer (auto-selected from the .wmv extension).
  // wmv2 has no VideoCodec union member (it predates VC-1) — probes to
  // 'unknown', same as any other codec the closed union doesn't name; the
  // Container side ('asf') is what this fixture exists to prove.
  encodeIfNeeded(
    "wmv2_wmav2.wmv",
    [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      "-c:v", "wmv2", "-c:a", "wmav2", "-ac", "2",
    ],
    { container: "asf", videoCodec: "unknown", audioCodec: "unknown", channels: 2, interlaced: false },
    ["wmv2", "wmav2"],
  );

  // mpg: mpeg2video + mp2, MPEG-PS ('mpeg' muxer — shared by .mpg/.mpeg/
  // .vob, docs/PLAYBACK.md §2.1's single 'mpeg' Container member). mp2 has
  // no AudioCodec union member -> probes to 'unknown' (same escape hatch as
  // every other codec union).
  encodeIfNeeded(
    "mpeg2video_mp2.mpg",
    [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      "-c:v", "mpeg2video", "-c:a", "mp2", "-ac", "2",
      "-f", "mpeg",
    ],
    { container: "mpeg", videoCodec: "mpeg2", audioCodec: "unknown", channels: 2, interlaced: false },
    ["mpeg2video", "mp2"],
  );

  // vob: mpeg2 + ac3 via the DVD-flavored MPEG-PS ('dvd') muxer — probes to
  // the SAME 'mpeg' format_name/Container as .mpg/.mpeg (verified
  // empirically), plus an extra dvd_nav_packet data stream that
  // extractMediaInfo already skips (codec_type 'data'). Real codec support
  // this time (ac3), unlike the mp2 case above.
  encodeIfNeeded(
    "mpeg2_ac3.vob",
    [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      "-c:v", "mpeg2video", "-c:a", "ac3", "-b:a", "192k", "-ac", "2",
      "-f", "dvd",
    ],
    { container: "mpeg", videoCodec: "mpeg2", audioCodec: "ac3", channels: 2, interlaced: false },
    ["mpeg2video", "ac3"],
  );

  // flv: h264 + aac — the flv muxer accepts this pairing directly (verified
  // empirically; no need for the flv1/mp3 fallback the task brief flagged
  // as a possibility).
  encodeIfNeeded(
    "h264_aac.flv",
    [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      "-c:v", "libx264", "-c:a", "aac", "-ac", "2",
    ],
    { container: "flv", videoCodec: "h264", audioCodec: "aac", channels: 2, interlaced: false },
    ["libx264", "aac"],
  );

  // aac: bare ADTS stream (no container muxing beyond the adts framing
  // itself) — audio-only, same shape as the flac/mp3/m4a baselines above.
  encodeIfNeeded(
    "audio.aac",
    ["-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-c:a", "aac"],
    { container: "aac", audioCodec: "aac", channels: 1 },
    ["aac"],
  );

  // aiff: pcm_s16be (Audio IFF's native uncompressed format).
  encodeIfNeeded(
    "audio.aiff",
    ["-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-c:a", "pcm_s16be"],
    { container: "aiff", audioCodec: "pcm", channels: 1 },
    ["pcm_s16be"],
  );

  // --- Owner ledger L1: .mts admission (identical mpegts family as the
  // baseline mpeg2_interlaced_ac3.ts fixture above and the admitted
  // .m2ts extension) ---
  //
  // h264 + aac muxed with the mpegts muxer, passed explicitly via -f
  // mpegts since ffmpeg cannot infer the right muxer from the unfamiliar
  // .mts extension (unlike .ts, which it recognizes). Container resolves
  // to 'ts' — the SAME value the plain mpeg2_interlaced_ac3.ts fixture
  // above produces — so this entry is placed AFTER that one on purpose:
  // probe.integration.spec.ts's "genuinely detected as interlaced" test
  // finds the FIRST manifest entry whose container is 'ts', and that must
  // stay the interlaced baseline fixture, not this one.
  encodeIfNeeded(
    "h264_aac.mts",
    [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      "-c:v", "libx264", "-c:a", "aac", "-ac", "2",
      "-f", "mpegts",
    ],
    { container: "ts", videoCodec: "h264", audioCodec: "aac", channels: 2, interlaced: false },
    ["libx264", "aac"],
  );

  // hevc 10-bit main10 is optional bonus coverage: only when libx265 is
  // present, feature-detected and skipped gracefully otherwise (per the
  // deliverable's "skip hevc/10-bit variants gracefully when libx265
  // absent" instruction).
  encodeIfNeeded(
    "hevc10_main10.mkv",
    [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1,format=yuv420p10le",
      "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-profile:v", "main10", "-an",
    ],
    { container: "mkv", videoCodec: "hevc", bitDepth: 10, interlaced: false },
    ["libx265"],
  );

  // ---------------------------------------------------------------------
  // docs/PLAYBACK.md §10 dimension-grid extension (Phase 3 §11 step 1)
  // ---------------------------------------------------------------------

  // Video grid: container {mp4,mkv,ts,avi} x video {h264,hevc} x bitDepth
  // {8,10} x hdr {none,hdr10,hlg} x interlaced {y,n}. HDR is tagged via
  // generic ffmpeg color_primaries/color_trc/colorspace output metadata
  // (works for either encoder) plus an x265-only master-display/max-cll SEI
  // for hdr10 (x264 has no equivalent flag — documented simplification, not
  // a bug: docs/PLAYBACK.md §10 says "where the encoder supports it").
  // Interlacing is `tinterlace`+`fieldorder` in the lavfi source chain, the
  // same technique the baseline mpeg2_interlaced_ac3.ts fixture above uses.
  // HDR at 8-bit is semantically invalid (PQ/HLG transfer curves are
  // 10-bit-only in practice) so it's recorded as skipped WITHOUT even
  // invoking ffmpeg, rather than silently narrowing the grid.
  const VIDEO_GRID_CONTAINERS = ["mp4", "mkv", "ts", "avi"];
  const VIDEO_GRID_CODECS = { h264: "libx264", hevc: "libx265" };
  const VIDEO_GRID_BITDEPTHS = [8, 10];
  const VIDEO_GRID_HDR = ["none", "hdr10", "hlg"];
  const VIDEO_GRID_INTERLACED = [false, true];

  function pixFmt(bitDepth) {
    return bitDepth === 10 ? "yuv420p10le" : "yuv420p";
  }

  for (const container of VIDEO_GRID_CONTAINERS) {
    for (const [codec, encoder] of Object.entries(VIDEO_GRID_CODECS)) {
      for (const bitDepth of VIDEO_GRID_BITDEPTHS) {
        for (const hdr of VIDEO_GRID_HDR) {
          for (const interlaced of VIDEO_GRID_INTERLACED) {
            const fileName = `grid_${container}_${codec}_${bitDepth}bit_${hdr}_${interlaced ? "i" : "p"}.${container}`;
            const expect = {
              container,
              videoCodec: codec,
              audioCodec: "aac",
              channels: 2,
              bitDepth,
              hdr,
              interlaced,
            };

            if (hdr !== "none" && bitDepth !== 10) {
              addSkipped({ file: fileName, ...expect, skipped: true, reason: "hdr-requires-10bit" });
              continue;
            }

            // Verified empirically (ffmpeg 8.1.1): ffmpeg's AVI muxer
            // accepts an HEVC stream and exits 0, but writes it in a form
            // ffprobe cannot identify — ffprobe reports the track back as
            // codec_name "rawvideo", not "hevc". A "generated" fixture that
            // lies about its own codec is worse than no fixture (it would
            // make the probe pipeline's integration test assert against a
            // wrong ground truth), so this combo is skipped rather than
            // attempted, across every bitDepth/hdr/interlaced variant.
            if (container === "avi" && codec === "hevc") {
              addSkipped({ file: fileName, ...expect, skipped: true, reason: "avi-mux-cannot-identify-hevc" });
              continue;
            }

            // Also verified empirically: an mpegts-muxed HEVC stream's
            // field_order comes back "progressive" from ffprobe even with
            // the exact same `-x265-params interlace=tff` that correctly
            // produces field_order "tb" when muxed into mkv/mp4 — an
            // mpegts+HEVC-specific parsing gap, not this script's bug (h264
            // in ts DOES carry field_order correctly, see the plain
            // mpeg2_interlaced_ac3.ts fixture and grid_ts_h264_*_i.ts).
            if (container === "ts" && codec === "hevc" && interlaced) {
              addSkipped({ file: fileName, ...expect, skipped: true, reason: "ts-mux-hevc-interlace-flag-lost" });
              continue;
            }

            // `tinterlace`+`fieldorder` weaves the pixel data into fields,
            // but libx264/libx265 still tag the *bitstream* progressive
            // unless separately told the source is field-coded — verified
            // empirically against ffmpeg 8.1.1: without the encoder-level
            // flags below, ffprobe's field_order comes back "progressive"
            // even though the pixels are interlaced, which would make the
            // fixture assert the wrong `interlaced` value.
            let lavfiChain = `testsrc2=size=320x240:rate=25:duration=1,format=${pixFmt(bitDepth)}`;
            if (interlaced) lavfiChain += ",tinterlace=4,fieldorder=tff";

            const args = [
              "-f", "lavfi", "-i", lavfiChain,
              "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
              "-c:v", encoder, "-preset", "ultrafast", "-pix_fmt", pixFmt(bitDepth),
            ];

            const x265Params = [];
            if (interlaced) {
              if (encoder === "libx264") args.push("-flags:v", "+ildct+ilme", "-x264opts", "tff=1");
              else x265Params.push("interlace=tff");
            }

            if (hdr === "hdr10") {
              args.push("-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc");
              if (encoder === "libx265") {
                x265Params.push(
                  "hdr10=1",
                  "repeat-headers=1",
                  "master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)",
                  "max-cll=1000,400",
                );
              }
              // libx264 has no master-display SEI support — color-metadata
              // tags only (docs/PLAYBACK.md §10: "where the encoder
              // supports it").
            } else if (hdr === "hlg") {
              args.push("-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc");
            }

            if (x265Params.length > 0) args.push("-x265-params", x265Params.join(":"));

            args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
            if (container === "ts") args.push("-f", "mpegts");

            encodeIfNeeded(fileName, args, expect, [encoder, "aac"]);
          }
        }
      }
    }
  }

  // Audio grid: codec {aac,ac3,eac3,flac,opus} x channels {2,6,8}. Muxed
  // uniformly into mkv (a universal container) so codec choice never fights
  // container support. Channel counts an encoder can't produce are caught
  // generically by encodeIfNeeded's ffmpeg-exit-nonzero skip path — no need
  // to hand-curate per-codec channel ceilings.
  const AUDIO_GRID_CODECS = { aac: "aac", ac3: "ac3", eac3: "eac3", flac: "flac", opus: "libopus" };
  const AUDIO_GRID_CHANNELS = [2, 6, 8];

  for (const [codec, encoder] of Object.entries(AUDIO_GRID_CODECS)) {
    for (const channels of AUDIO_GRID_CHANNELS) {
      const fileName = `audio_${codec}_${channels}ch.mkv`;
      const args = ["-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-c:a", encoder, "-ac", String(channels)];
      if (codec === "opus" && channels > 2) {
        // libopus needs an explicit mapping family for >2 channels.
        args.push("-mapping_family", "1");
      }
      if (codec === "ac3" || codec === "eac3") {
        args.push("-b:a", channels > 2 ? "384k" : "192k");
      }
      encodeIfNeeded(fileName, args, { container: "mkv", audioCodec: codec, channels }, [encoder]);
    }
  }

  // Embedded ASS subtitle track (srt embedded coverage already exists via
  // h264_aac_subrip.mkv above).
  (() => {
    const fileName = "h264_aac_ass.mkv";
    const assPath = outPath("caption.ass");
    writeFileSync(
      assPath,
      "[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\n" +
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
        "Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n\n" +
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
        "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Loombre fixture\n",
    );
    encodeIfNeeded(
      fileName,
      [
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
        "-i", assPath,
        "-c:v", "libx264", "-c:a", "aac", "-ac", "2", "-c:s", "ass",
        "-metadata:s:s:0", "language=eng",
      ],
      { container: "mkv", videoCodec: "h264", audioCodec: "aac", subtitleCodec: "ass", channels: 2, interlaced: false },
      ["libx264", "aac", "ass"],
    );
  })();

  // External .srt sidecar emission: a plain .srt living NEXT TO the video
  // with a matching basename, never muxed in (docs/PLAYBACK.md §2.1
  // externalPath). Recorded as an `externalSubtitle` field on the VIDEO
  // entry rather than its own `files` entry — a bare .srt isn't a probeable
  // media container, and probe.integration.spec.ts ffprobes every `files`
  // entry, so giving the sidecar its own entry would break that consumer.
  (() => {
    const fileName = "external_sidecar.mp4";
    const sidecarFileName = "external_sidecar.srt";
    encodeIfNeeded(
      fileName,
      [
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
        "-c:v", "libx264", "-c:a", "aac", "-ac", "2",
        "-movflags", "+faststart",
      ],
      {
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        channels: 2,
        interlaced: false,
        externalSubtitle: sidecarFileName,
      },
      ["libx264", "aac"],
    );
    if (existsSync(outPath(fileName))) {
      writeFileSync(outPath(sidecarFileName), "1\n00:00:00,000 --> 00:00:01,000\nLoombre external sidecar fixture\n");
    }
  })();

  // av1/mpeg2-progressive/truehd/dts: feature-detected extras (docs/PLAYBACK.md
  // §10 "plus av1/vp9/mpeg2 and truehd/dts WHERE the resolved ffmpeg has
  // encoders" — vp9/mpeg2 baseline coverage already exists above).
  (() => {
    const av1Encoder = encoders.has("libsvtav1") ? "libsvtav1" : encoders.has("libaom-av1") ? "libaom-av1" : null;
    const av1Expect = { container: "mkv", videoCodec: "av1", audioCodec: "opus", channels: 2, interlaced: false };
    if (av1Encoder) {
      const args = [
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
        "-c:v", av1Encoder,
        ...(av1Encoder === "libsvtav1" ? ["-preset", "12"] : ["-cpu-used", "8"]),
        "-c:a", "libopus", "-ac", "2",
      ];
      encodeIfNeeded("av1_opus.mkv", args, av1Expect, [av1Encoder, "libopus"]);
    } else {
      addSkipped({ file: "av1_opus.mkv", ...av1Expect, skipped: true, reason: "missing-encoder:av1" });
    }
  })();

  // mpeg2 progressive (the baseline mpeg2 fixture above is interlaced-only).
  encodeIfNeeded(
    "mpeg2_progressive_ac3.ts",
    [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      "-c:v", "mpeg2video", "-c:a", "ac3", "-b:a", "192k", "-ac", "2", "-f", "mpegts",
    ],
    { container: "ts", videoCodec: "mpeg2", audioCodec: "ac3", channels: 2, interlaced: false },
    ["mpeg2video", "ac3"],
  );

  // truehd (experimental ffmpeg encoder, absent on many stock builds).
  encodeIfNeeded(
    "audio_truehd_6ch.mkv",
    ["-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-c:a", "truehd", "-strict", "-2", "-ac", "6"],
    { container: "mkv", audioCodec: "truehd", channels: 6 },
    ["truehd"],
  );

  // dts (ffmpeg's `dca` encoder — experimental, absent on many stock builds).
  encodeIfNeeded(
    "audio_dts_6ch.mkv",
    ["-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-c:a", "dca", "-strict", "-2", "-ac", "6"],
    { container: "mkv", audioCodec: "dts", channels: 6 },
    ["dca"],
  );

  // Phase 3 §11 step 6a (transcode session runtime, apps/worker/test/
  // transcode/session.integration.spec.ts): a single LONG (150s) h264/aac
  // source those tests drive real ffmpeg HLS session pipelines against.
  // Needs real wall-clock duration — not the 1s clips above — so the
  // segment-ahead throttle scenario (docs/PLAYBACK.md §9: ahead > 10
  // segments) has enough segments to accumulate a real double-digit gap
  // WHILE ffmpeg is still actively encoding (that spec file's own header
  // explains the deliberate test-only -readrate pacing aid that makes this
  // deterministic across machines of very different raw encode speed).
  encodeIfNeeded(
    "session_long.mp4",
    [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=150",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=150",
      "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-movflags", "+faststart",
    ],
    { container: "mp4", videoCodec: "h264", audioCodec: "aac", channels: 2, interlaced: false },
    ["libx264", "aac"],
  );

  // Dolby Vision + PGS: expected-unavailable via stock ffmpeg (docs/PLAYBACK.md
  // §10 deliverable note) — recorded as skipped, never attempted. Real
  // coverage lives in the hand-authored probe fixtures instead (e.g.
  // apps/worker/test/probe/fixtures/raw/03_hevc_dv8_blcompat1.json).
  addSkipped({
    file: "dolby_vision_profile8.mkv",
    container: "mkv",
    videoCodec: "hevc",
    hdr: "dv",
    skipped: true,
    reason: "not-generatable-stock-ffmpeg",
  });
  addSkipped({
    file: "pgs_subtitle.mkv",
    container: "mkv",
    subtitleCodec: "pgs",
    skipped: true,
    reason: "not-generatable-stock-ffmpeg",
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    files: manifestFiles,
    skipped: manifestSkipped,
  };
  writeFileSync(join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(
    `[gen-media-fixtures] wrote ${manifestFiles.length} generated file(s), ${manifestSkipped.length} skipped combo(s) to ${OUTPUT_DIR}`,
  );
  if (manifestSkipped.length > 0) {
    const sample = manifestSkipped.slice(0, 6).map((s) => `${s.file} (${s.reason})`).join(", ");
    console.log(
      `[gen-media-fixtures] example skips: ${sample}${manifestSkipped.length > 6 ? ", ..." : ""}`,
    );
  }
}

main();
