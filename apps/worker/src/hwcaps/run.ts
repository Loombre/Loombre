// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Real wiring: resolves ffmpeg (LOOMBRE_FFMPEG env -> PATH, per P1.18/
 * ffprobe.ts's resolveFfmpeg()), feature-detects encoders, computes both
 * fingerprints, runs the full battery for the CURRENT platform's candidate
 * backends, and assembles a complete `ProbeReport`. Shared by both real
 * consumers of this module: the `pnpm --filter @loombre/worker run hwprobe`
 * operator script (run-hwprobe.ts) and the 'hwprobe' job consumer wired
 * into apps/worker/src/index.ts — persistence is a SEPARATE step
 * (persist.ts) so the operator script can print the report before
 * deciding anything about the DB, and so a lightweight fingerprint-only
 * check (computeCurrentFingerprint, used by the boot-time invalidation
 * check) never pays the cost of a full battery run.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFfmpeg } from "../probe/ffprobe.js";
import { buildListEncodersArgs, parseEncoderNames } from "./args.js";
import { runProbeBattery } from "./battery.js";
import { createRealCommandRunner } from "./command-runner.js";
import { computeFfmpegBuildHash, computeGpuFingerprint } from "./fingerprint.js";
import { candidatesForPlatform } from "./platforms.js";
import { probeFileReal } from "./probe-file.js";
import type { ProbeReport } from "./types.js";

const ENCODER_LIST_TIMEOUT_MS = 10_000;

export interface CurrentFingerprint {
  platform: NodeJS.Platform;
  ffmpegBuildHash: string;
  gpuFingerprint: string;
}

/**
 * The lightweight half: resolves ffmpeg + computes both fingerprints,
 * WITHOUT running the battery. `null` when ffmpeg can't be resolved at all
 * (LOOMBRE_FFMPEG unset/invalid and nothing on PATH) — the boot check
 * treats that as "can't determine, log and move on" rather than a crash
 * (P1.9 spirit: a missing binary is a clean, reportable condition).
 */
export async function computeCurrentFingerprint(): Promise<CurrentFingerprint | null> {
  const resolved = resolveFfmpeg();
  if (!resolved.ok) return null;
  const runner = createRealCommandRunner();
  const [ffmpegBuildHash, gpuFingerprint] = await Promise.all([
    computeFfmpegBuildHash(runner, resolved.binary.path),
    computeGpuFingerprint(runner, process.platform),
  ]);
  return { platform: process.platform, ffmpegBuildHash, gpuFingerprint };
}

/**
 * Runs the FULL battery for the current platform against the resolved
 * ffmpeg and returns a complete `ProbeReport`. Throws only when ffmpeg
 * can't be resolved at all (same ProbeError apps/worker/src/probe/
 * ffprobe.ts's own callers already handle) — every per-test failure
 * degrades to that test's outcome, never an exception out of this
 * function.
 */
export async function runRealHwProbeBattery(): Promise<ProbeReport> {
  const resolved = resolveFfmpeg();
  if (!resolved.ok) {
    throw resolved.error;
  }
  const ffmpegPath = resolved.binary.path;
  const runner = createRealCommandRunner();

  const encodersResult = await runner.run(ffmpegPath, buildListEncodersArgs(), {
    timeoutMs: ENCODER_LIST_TIMEOUT_MS,
  });
  const encoders = parseEncoderNames(encodersResult.stdout);

  const [ffmpegBuildHash, gpuFingerprint] = await Promise.all([
    computeFfmpegBuildHash(runner, ffmpegPath),
    computeGpuFingerprint(runner, process.platform),
  ]);

  const workDir = await mkdtemp(join(tmpdir(), "loombre-hwprobe-"));
  try {
    const backends = candidatesForPlatform(process.platform);
    const result = await runProbeBattery({
      backends,
      runCommand: runner,
      probeFile: probeFileReal,
      ffmpegPath,
      workDir,
      clock: Date.now,
      encoders,
    });

    return {
      platform: process.platform,
      ffmpegPath,
      ffmpegBuildHash,
      gpuFingerprint,
      generatedAtMs: Date.now(),
      backends: result.backends,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
