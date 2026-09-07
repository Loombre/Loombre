// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/transcode/seek-origin.ts
//
// Where does a stream-copy seek run REALLY start? (Owner report from the
// Linux reference box, 2026-09-07, measured frame-by-frame: a seek to
// 5:00.000 delivered the source keyframe at 4:55.462 as its first frame,
// and the run was labelled 5:00.000 — so every subtitle cue, absolute in
// source time, ran 4.5 s early until the next seek.)
//
// `-ss T` before `-i` seeks the DEMUXER, which lands on the last keyframe
// at or before T (and, in practice, sometimes the one before that when T
// sits exactly on a keyframe — measured on ffmpeg 8.1.1/matroska). With
// `-c:v copy` nothing can trim the frames between that keyframe and T, so
// the run's output timeline starts at the keyframe, not at T; a decoding
// run (transcode) trims to T exactly and is unaffected. transcode_runs.
// source_origin_ms is the anchor the playlist's PROGRAM-DATE-TIME and the
// server's segment→source mapping are built on (docs/PLAYBACK.md §9.1.3),
// so for a copy run it must be the landing keyframe, never the request.
//
// Measurement: the same binary, the same `-ss T -i file` input seek, the
// same stream, `-c copy`, ONE packet, `-copyts` so the packet keeps its
// source timestamp, written through the framecrc muxer whose text output
// carries `#tb <idx>: <num>/<den>` and one `idx, dts, pts, ...` line. The
// seek path is libavformat's, identical to the real run's, so the answer
// is what that run will do — not a prediction from a keyframe table.
// Bounded: one spawn, one packet, a hard timeout; any failure resolves
// `null` and the caller falls back to the requested target (the pre-fix
// behaviour), never a guessed value.

import { spawn } from "node:child_process";

export interface MeasureSeekOriginInput {
  ffmpegPath: string;
  filePath: string;
  /** Type-relative video stream index (`-map 0:v:N`), as the plan maps it. */
  videoTypeIndex: number;
  seekTargetMs: number;
  timeoutMs?: number;
}

const TB_LINE = /^#tb\s+(\d+):\s*(\d+)\/(\d+)\s*$/m;
const PACKET_LINE = /^(\d+),\s*(-?\d+),\s*(-?\d+),/m;

/** Parses framecrc text into the first packet's pts in milliseconds, or
 *  null when the output has no timebase/packet line. Exported for tests. */
export function parseFramecrcFirstPts(output: string): number | null {
  const tb = TB_LINE.exec(output);
  const pkt = PACKET_LINE.exec(output);
  if (!tb || !pkt) return null;
  const num = Number(tb[2]);
  const den = Number(tb[3]);
  const pts = Number(pkt[3]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || !Number.isFinite(pts)) return null;
  return Math.round((pts * num * 1000) / den);
}

export function seekOriginProbeArgs(input: MeasureSeekOriginInput): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-ss",
    String(input.seekTargetMs / 1000),
    "-i",
    input.filePath,
    "-map",
    `0:v:${input.videoTypeIndex}`,
    "-c",
    "copy",
    "-copyts",
    "-frames:v",
    "1",
    "-f",
    "framecrc",
    "-",
  ];
}

export async function measureCopySeekOriginMs(input: MeasureSeekOriginInput): Promise<number | null> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  return new Promise<number | null>((resolve) => {
    let child;
    try {
      child = spawn(input.ffmpegPath, seekOriginProbeArgs(input), { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        finish(null);
        return;
      }
      const ms = parseFramecrcFirstPts(out);
      // A landing AFTER the target is not a backward seek — refuse it
      // rather than push the anchor forward.
      finish(ms !== null && ms <= input.seekTargetMs ? ms : null);
    });
  });
}

/** The `-map 0:v:N` index the plan's own args select, so the probe reads
 *  the same stream the run copies. Defaults to 0 (the plan builder's own
 *  default for a single-video-stream file). */
export function videoTypeIndexFromArgs(args: readonly string[]): number {
  for (let i = 0; i + 1 < args.length; i += 1) {
    if (args[i] !== "-map") continue;
    const m = /^0:v:(\d+)$/.exec(args[i + 1] ?? "");
    if (m) return Number(m[1]);
  }
  return 0;
}
