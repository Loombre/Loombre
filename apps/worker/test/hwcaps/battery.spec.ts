// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/hwcaps/battery.spec.ts
//
// Unit tests for the pure-orchestration battery (binding constraint 1/7):
// every scenario here uses a FAKE CommandRunner + fake ProbeFileFn — never
// real ffmpeg. Covers: per-backend/codec orchestration, timeout->absent,
// platform ordering (software last), report structure, and the specific
// "frame count matched but hardware never actually engaged" failure mode
// this lane found for real on the M3 Max (av1/vp9 silently soft-falling-
// back through ffmpeg's own `videotoolbox` hwaccel).

import { describe, expect, it } from "vitest";
import { runProbeBattery } from "../../src/hwcaps/battery.js";
import { toVerifiedCapabilities } from "../../src/hwcaps/report.js";
import { createFakeProbeFile, createFakeRunner, fakeClock, okResult, timeoutResult } from "./helpers.js";

const NO_ENCODERS = new Set<string>();
const ALL_SOFTWARE_ENCODERS = new Set(["libx264", "libx265", "libvpx-vp9", "mpeg2video", "libsvtav1", "libaom-av1"]);

function lastArg(args: string[]): string {
  return args[args.length - 1]!;
}
function isDecodeTest(args: string[]): boolean {
  return args.includes("-an") && lastArg(args) === "-";
}
function basename(path: string): string {
  return path.split("/").pop()!;
}

describe("runProbeBattery", () => {
  it("tests every backend in the supplied order and preserves it as `position`", async () => {
    const runner = createFakeRunner(() => okResult("", "frame=   50 fps=0.0\n"));
    const probeFile = createFakeProbeFile(() => ({ codecName: "h264", colorTransfer: "bt709" }));

    const result = await runProbeBattery({
      backends: ["videotoolbox", "software"],
      runCommand: runner,
      probeFile,
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });

    expect(result.backends.map((b) => b.backend)).toEqual(["videotoolbox", "software"]);
    expect(result.backends.map((b) => b.position)).toEqual([0, 1]);
  });

  it("every backend report carries decode/encode/toneMap arrays sized to the tested candidate sets", async () => {
    const runner = createFakeRunner((call) => {
      if (isDecodeTest(call.args)) {
        return okResult("", "Reinit context to 320x240, pix_fmt: videotoolbox_vld\nframe=   50 fps=0.0\n");
      }
      return okResult();
    });
    const probeFile = createFakeProbeFile((filePath) => {
      if (basename(filePath).startsWith("encode-")) return { codecName: basename(filePath).includes("hevc") ? "hevc" : "h264", colorTransfer: null };
      if (basename(filePath).startsWith("tonemap-")) return { codecName: null, colorTransfer: "bt709" };
      return null;
    });

    const result = await runProbeBattery({
      backends: ["videotoolbox", "software"],
      runCommand: runner,
      probeFile,
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });

    const vt = result.backends.find((b) => b.backend === "videotoolbox")!;
    const sw = result.backends.find((b) => b.backend === "software")!;
    expect(vt.decode).toHaveLength(5); // {h264,hevc,av1,vp9,mpeg2}
    expect(vt.encode).toHaveLength(3); // {h264,hevc,av1}
    expect(vt.toneMap).toHaveLength(1); // videotoolbox candidate: ['videotoolbox']
    expect(sw.toneMap).toHaveLength(0); // software has NO tone-map candidates (see tables.ts header)
  });

  it("real-machine finding, reproduced: frame count matches but the hwaccel marker never appears -> FAIL, not pass (silent software fallback caught)", async () => {
    // Exactly what this lane observed for real: `ffmpeg -hwaccel
    // videotoolbox` on an av1/vp9 source exits 0 with the correct frame
    // count, but the verbose log never shows `pix_fmt: videotoolbox_vld`
    // — it silently decoded on the CPU instead.
    const runner = createFakeRunner((call) => {
      if (isDecodeTest(call.args)) {
        return okResult("", "Reinit context to 320x240, pix_fmt: p010le\nframe=   50 fps=0.0\n");
      }
      return okResult();
    });
    const probeFile = createFakeProbeFile(() => null);

    const result = await runProbeBattery({
      backends: ["videotoolbox"],
      runCommand: runner,
      probeFile,
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });

    const vt = result.backends[0]!;
    for (const decodeResult of vt.decode) {
      expect(decodeResult.outcome, decodeResult.subject).toBe("fail");
      expect(decodeResult.detail).toContain("hwaccel-not-engaged");
    }
  });

  it("decode genuinely engaging hardware (marker present + correct frame count) -> pass", async () => {
    const runner = createFakeRunner((call) => {
      if (isDecodeTest(call.args)) {
        return okResult("", "Reinit context to 320x240, pix_fmt: videotoolbox_vld\nframe=   50 fps=0.0\n");
      }
      return okResult();
    });
    const result = await runProbeBattery({
      backends: ["videotoolbox"],
      runCommand: runner,
      probeFile: createFakeProbeFile(() => null),
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });
    for (const decodeResult of result.backends[0]!.decode) {
      expect(decodeResult.outcome).toBe("pass");
    }
  });

  it("software backend's decode test needs no hwaccel marker at all (trivially engaged)", async () => {
    const runner = createFakeRunner((call) => {
      if (isDecodeTest(call.args)) return okResult("", "frame=   50 fps=0.0\n"); // no marker line at all
      return okResult();
    });
    const result = await runProbeBattery({
      backends: ["software"],
      runCommand: runner,
      probeFile: createFakeProbeFile(() => null),
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });
    for (const decodeResult of result.backends[0]!.decode) {
      expect(decodeResult.outcome).toBe("pass");
    }
  });

  it("timeout on a decode test -> outcome 'timeout' (never silently absent-without-explanation)", async () => {
    const runner = createFakeRunner((call) => {
      if (isDecodeTest(call.args)) return timeoutResult("hung");
      return okResult();
    });
    const result = await runProbeBattery({
      backends: ["software"],
      runCommand: runner,
      probeFile: createFakeProbeFile(() => null),
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
      timeoutMs: 50,
    });
    for (const decodeResult of result.backends[0]!.decode) {
      expect(decodeResult.outcome).toBe("timeout");
      expect(decodeResult.detail).toMatch(/exceeded 50ms/);
    }
  });

  it("timeout on an encode test -> outcome 'timeout'", async () => {
    const runner = createFakeRunner((call) => {
      if (basename(lastArg(call.args)).startsWith("encode-")) return timeoutResult();
      return okResult();
    });
    const result = await runProbeBattery({
      backends: ["software"],
      runCommand: runner,
      probeFile: createFakeProbeFile(() => null),
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });
    for (const encodeResult of result.backends[0]!.encode) {
      expect(encodeResult.outcome).toBe("timeout");
    }
  });

  it("no local software encoder for a codec -> decode+encode both 'skipped' (untested->absent), not 'fail'", async () => {
    const result = await runProbeBattery({
      backends: ["software"],
      runCommand: createFakeRunner(() => okResult("", "frame=   50 fps=0.0\n")),
      probeFile: createFakeProbeFile(() => null),
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: NO_ENCODERS, // nothing available at all
    });
    const sw = result.backends[0]!;
    for (const r of [...sw.decode, ...sw.encode]) {
      expect(r.outcome, r.subject).toBe("skipped");
    }
  });

  it("videotoolbox has NO av1 encoder table entry -> av1 encode is skipped for it even when av1 software encoders exist", async () => {
    const result = await runProbeBattery({
      backends: ["videotoolbox"],
      runCommand: createFakeRunner(() => okResult("", "frame=   50 fps=0.0\n")),
      probeFile: createFakeProbeFile(() => ({ codecName: "h264", colorTransfer: null })),
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });
    const av1Encode = result.backends[0]!.encode.find((r) => r.subject === "av1")!;
    expect(av1Encode.outcome).toBe("skipped");
  });

  it("encode test: re-probed codec mismatch -> fail", async () => {
    const runner = createFakeRunner(() => okResult());
    const probeFile = createFakeProbeFile(() => ({ codecName: "vp9", colorTransfer: null })); // wrong codec
    const result = await runProbeBattery({
      backends: ["software"],
      runCommand: runner,
      probeFile,
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });
    const h264Encode = result.backends[0]!.encode.find((r) => r.subject === "h264")!;
    expect(h264Encode.outcome).toBe("fail");
    expect(h264Encode.detail).toContain("vp9");
  });

  it("encode test: re-probe returns null (couldn't confirm) -> fail, not pass", async () => {
    const result = await runProbeBattery({
      backends: ["software"],
      runCommand: createFakeRunner(() => okResult()),
      probeFile: createFakeProbeFile(() => null),
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });
    for (const r of result.backends[0]!.encode) {
      expect(r.outcome).toBe("fail");
    }
  });

  it("tone-map test: color_transfer isn't bt709 after the filter -> fail", async () => {
    const result = await runProbeBattery({
      backends: ["videotoolbox"],
      runCommand: createFakeRunner(() => okResult()),
      probeFile: createFakeProbeFile((filePath) =>
        basename(filePath).startsWith("tonemap-") ? { codecName: "h264", colorTransfer: "smpte2084" } : { codecName: "h264", colorTransfer: null },
      ),
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });
    const toneMapResult = result.backends[0]!.toneMap[0]!;
    expect(toneMapResult.outcome).toBe("fail");
    expect(toneMapResult.detail).toContain("smpte2084");
  });

  it("tone-map test: color_transfer bt709 -> pass", async () => {
    const result = await runProbeBattery({
      backends: ["videotoolbox"],
      runCommand: createFakeRunner(() => okResult()),
      probeFile: createFakeProbeFile((filePath) =>
        basename(filePath).startsWith("tonemap-") ? { codecName: "h264", colorTransfer: "bt709" } : { codecName: "h264", colorTransfer: null },
      ),
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });
    expect(result.backends[0]!.toneMap[0]!.outcome).toBe("pass");
  });

  it("HDR source generation failure -> every tone-map candidate is 'skipped', never attempted", async () => {
    const runner = createFakeRunner((call) => {
      if (lastArg(call.args) === "/tmp/fake/hdr10-source.mkv") return timeoutResult();
      return okResult();
    });
    const result = await runProbeBattery({
      backends: ["videotoolbox"],
      runCommand: runner,
      probeFile: createFakeProbeFile(() => null),
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });
    expect(result.backends[0]!.toneMap[0]!.outcome).toBe("skipped");
    expect(result.backends[0]!.toneMap[0]!.detail).toContain("no-hdr-source");
  });

  it("qsv/vaapi test BOTH opencl and vulkan as tone-map candidates (§8.3's opencl-else-vulkan table)", async () => {
    const result = await runProbeBattery({
      backends: ["qsv", "vaapi"],
      runCommand: createFakeRunner(() => okResult()),
      probeFile: createFakeProbeFile(() => ({ codecName: "h264", colorTransfer: "bt709" })),
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });
    for (const backend of result.backends) {
      expect(backend.toneMap.map((r) => r.subject).sort()).toEqual(["opencl", "vulkan"]);
    }
  });

  it("amf and d3d11va have no tone-map candidates at all (§8.3 names no method for either)", async () => {
    const result = await runProbeBattery({
      backends: ["amf", "d3d11va"],
      runCommand: createFakeRunner(() => okResult()),
      probeFile: createFakeProbeFile(() => null),
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      encoders: ALL_SOFTWARE_ENCODERS,
    });
    expect(result.backends[0]!.toneMap).toEqual([]);
    expect(result.backends[1]!.toneMap).toEqual([]);
  });

  it("toVerifiedCapabilities extracts only PASSing subjects, preserving backend order", async () => {
    const runner = createFakeRunner((call) => {
      if (isDecodeTest(call.args) && call.args.includes("-hwaccel")) {
        return okResult("", "Reinit context to 320x240, pix_fmt: videotoolbox_vld\nframe=   50 fps=0.0\n");
      }
      if (isDecodeTest(call.args)) return okResult("", "frame=   50 fps=0.0\n");
      return okResult();
    });
    const probeFile = createFakeProbeFile((filePath) => {
      const name = basename(filePath);
      if (name.startsWith("encode-videotoolbox-h264")) return { codecName: "h264", colorTransfer: null };
      if (name.startsWith("encode-") && name.includes("hevc")) return { codecName: "hevc", colorTransfer: null };
      if (name.startsWith("tonemap-")) return { codecName: null, colorTransfer: "bt709" };
      return null; // every other encode fails its re-probe
    });

    const result = await runProbeBattery({
      backends: ["videotoolbox", "software"],
      runCommand: runner,
      probeFile,
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/tmp/fake",
      clock: fakeClock(),
      // Includes videotoolbox's own encoder names too, so its encode tests
      // are actually ATTEMPTED (not skipped for "no local encoder") —
      // resolveEncoderName gates on real feature-detection for every
      // backend, hardware included, matching how the real `ffmpeg
      // -encoders` listing also lists hw encoder names when present.
      encoders: new Set([...ALL_SOFTWARE_ENCODERS, "h264_videotoolbox", "hevc_videotoolbox"]),
    });

    const verified = toVerifiedCapabilities(result);
    expect(verified.backends.map((b) => b.backend)).toEqual(["videotoolbox", "software"]);
    const vt = verified.backends[0]!;
    expect(vt.decode).toEqual(["h264", "hevc", "av1", "vp9", "mpeg2"]); // all engaged in this scenario
    expect(vt.encode).toEqual(["h264", "hevc"]); // av1 skipped (no table entry) -> absent
    expect(vt.toneMap).toEqual(["videotoolbox"]);
    const sw = verified.backends[1]!;
    expect(sw.toneMap).toEqual([]); // software never gets a tone-map capability entry
  });

  it("never throws even when every single test fails/times out/is skipped", async () => {
    const runner = createFakeRunner(() => timeoutResult());
    await expect(
      runProbeBattery({
        backends: ["videotoolbox", "software"],
        runCommand: runner,
        probeFile: createFakeProbeFile(() => null),
        ffmpegPath: "/fake/ffmpeg",
        workDir: "/tmp/fake",
        clock: fakeClock(),
        encoders: NO_ENCODERS,
      }),
    ).resolves.toBeDefined();
  });
});
