// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/hwcaps/real-battery.integration.spec.ts
//
// Session-integration-style test (not pure — real ffmpeg): runs the ACTUAL
// software-backend battery (real spawn, real re-probe) and asserts h264
// decode+encode pass, per this step's constraint 7. Skips cleanly (whole
// describe block) without ffmpeg — mirrors apps/worker/test/probe/
// probe.integration.spec.ts's own convention exactly.

import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildListEncodersArgs, parseEncoderNames } from "../../src/hwcaps/args.js";
import { runProbeBattery } from "../../src/hwcaps/battery.js";
import { createRealCommandRunner } from "../../src/hwcaps/command-runner.js";
import { probeFileReal } from "../../src/hwcaps/probe-file.js";
import { toVerifiedCapabilities } from "../../src/hwcaps/report.js";
import { validateVerifiedCapabilities } from "../../src/hwcaps/schema.js";
import { resolveFfmpeg } from "../../src/probe/ffprobe.js";

const ffmpegAvailable = ffmpegAvailableStrict();

describe.skipIf(!ffmpegAvailable)("hwcaps battery integration (real ffmpeg, software backend only)", () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "loombre-hwprobe-integration-"));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("software backend: real h264 decode + encode pass, output validates against the shared §2.5 schema", async () => {
    const resolved = resolveFfmpeg();
    if (!resolved.ok) throw resolved.error; // unreachable given skipIf, keeps TS happy
    const ffmpegPath = resolved.binary.path;
    const runner = createRealCommandRunner();

    const encodersResult = await runner.run(ffmpegPath, buildListEncodersArgs(), { timeoutMs: 10_000 });
    const encoders = parseEncoderNames(encodersResult.stdout);
    expect(encoders.has("libx264"), "this integration test requires a libx264-enabled ffmpeg build").toBe(true);

    const result = await runProbeBattery({
      backends: ["software"],
      runCommand: runner,
      probeFile: probeFileReal,
      ffmpegPath,
      workDir,
      clock: Date.now,
      encoders,
    });

    expect(result.backends).toHaveLength(1);
    const software = result.backends[0]!;
    expect(software.backend).toBe("software");

    const h264Decode = software.decode.find((r) => r.subject === "h264")!;
    expect(h264Decode.outcome, JSON.stringify(h264Decode)).toBe("pass");

    const h264Encode = software.encode.find((r) => r.subject === "h264")!;
    expect(h264Encode.outcome, JSON.stringify(h264Encode)).toBe("pass");

    const verified = toVerifiedCapabilities(result);
    const validation = validateVerifiedCapabilities(verified);
    expect(validation.valid, JSON.stringify(validation.violations)).toBe(true);
    expect(verified.backends[0]!.decode).toContain("h264");
    expect(verified.backends[0]!.encode).toContain("h264");
  }, 60_000);
});
