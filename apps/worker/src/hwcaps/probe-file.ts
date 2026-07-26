// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The REAL `ProbeFileFn` (types.ts) — re-probes a file the battery just
 * produced (an encode test's output, or a tone-map test's output) and
 * reports back the first video stream's raw `codec_name`/`color_transfer`.
 * Reuses the EXISTING probe pipeline's `runFfprobe` (apps/worker/src/
 * probe/ffprobe.ts) directly per this step's binding constraint ("reuse
 * its ffmpeg-resolution + spawn conventions") — this file adds no new
 * ffprobe spawn logic, just a thin extraction on top of the already-parsed
 * raw JSON. battery.ts never imports this module directly; only the real
 * wiring (run-hwprobe.ts, the 'hwprobe' job consumer) does, so unit tests
 * substitute a fake `ProbeFileFn` and never spawn a real ffprobe.
 */
import { runFfprobe } from "../probe/ffprobe.js";
import type { RawStream } from "../probe/types.js";
import type { ProbedFileInfo, ProbeFileFn } from "./types.js";

function firstVideoStream(streams: RawStream[] | undefined): RawStream | undefined {
  return streams?.find((s) => s["codec_type"] === "video");
}

export const probeFileReal: ProbeFileFn = async (filePath: string): Promise<ProbedFileInfo | null> => {
  try {
    const raw = await runFfprobe(filePath);
    const video = firstVideoStream(raw.streams);
    if (!video) return null;
    const codecName = video["codec_name"];
    const colorTransfer = video["color_transfer"];
    return {
      codecName: typeof codecName === "string" ? codecName : null,
      colorTransfer: typeof colorTransfer === "string" ? colorTransfer : null,
    };
  } catch {
    // A ProbeError (binary missing, timeout, nonzero exit, invalid JSON) on
    // a re-probe means "couldn't confirm the output" — treated identically
    // to "no video stream found" by every caller (both mean the encode/
    // tone-map test under evaluation fails its assertion).
    return null;
  }
};
