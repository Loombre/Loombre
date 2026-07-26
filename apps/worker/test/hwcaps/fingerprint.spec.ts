// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeFfmpegBuildHash, computeGpuFingerprint } from "../../src/hwcaps/fingerprint.js";
import { createFakeRunner, okResult, failResult, timeoutResult } from "./helpers.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("computeFfmpegBuildHash", () => {
  it("hashes the full `ffmpeg -version` stdout (version + configuration)", async () => {
    const stdout = "ffmpeg version 8.1.1\nconfiguration: --enable-videotoolbox --enable-gpl\n";
    const runner = createFakeRunner(() => okResult(stdout));
    const hash = await computeFfmpegBuildHash(runner, "/opt/homebrew/bin/ffmpeg");
    expect(hash).toBe(sha256(stdout));
    expect(runner.calls).toEqual([{ bin: "/opt/homebrew/bin/ffmpeg", args: ["-version"], options: { timeoutMs: 10_000 } }]);
  });

  it("a different configuration line (different build flags) yields a different hash at the same version", async () => {
    const withVt = createFakeRunner(() => okResult("ffmpeg version 8.1.1\nconfiguration: --enable-videotoolbox\n"));
    const withoutVt = createFakeRunner(() => okResult("ffmpeg version 8.1.1\nconfiguration: --disable-videotoolbox\n"));
    const hashWithVt = await computeFfmpegBuildHash(withVt, "ffmpeg");
    const hashWithoutVt = await computeFfmpegBuildHash(withoutVt, "ffmpeg");
    expect(hashWithVt).not.toBe(hashWithoutVt);
  });

  it("identical stdout always hashes identically (deterministic)", async () => {
    const runner = createFakeRunner(() => okResult("same stdout"));
    const a = await computeFfmpegBuildHash(runner, "ffmpeg");
    const b = await computeFfmpegBuildHash(runner, "ffmpeg");
    expect(a).toBe(b);
  });
});

describe("computeGpuFingerprint", () => {
  it("darwin: runs `system_profiler SPDisplaysDataType -detailLevel mini`", async () => {
    const runner = createFakeRunner(() => okResult("Chipset Model: Apple M3 Max\n"));
    const fp = await computeGpuFingerprint(runner, "darwin");
    expect(fp).toBe(sha256("Chipset Model: Apple M3 Max\n"));
    expect(runner.calls[0]).toEqual({
      bin: "system_profiler",
      args: ["SPDisplaysDataType", "-detailLevel", "mini"],
      options: { timeoutMs: 10_000 },
    });
  });

  it("linux: runs `lspci` and hashes only VGA/3D-filtered lines", async () => {
    const stdout = [
      "00:00.0 Host bridge: Intel Corporation Device 1234",
      "01:00.0 VGA compatible controller: NVIDIA Corporation Device 2782",
      "01:00.1 Audio device: NVIDIA Corporation Device 22bc",
      "02:00.0 3D controller: NVIDIA Corporation Device 20b8",
    ].join("\n");
    const runner = createFakeRunner(() => okResult(stdout));
    const fp = await computeGpuFingerprint(runner, "linux");
    const expectedFiltered = [
      "01:00.0 VGA compatible controller: NVIDIA Corporation Device 2782",
      "02:00.0 3D controller: NVIDIA Corporation Device 20b8",
    ].join("\n");
    expect(fp).toBe(sha256(expectedFiltered));
    expect(runner.calls[0]!.bin).toBe("lspci");
  });

  it("win32: runs `wmic path win32_VideoController get name`", async () => {
    const runner = createFakeRunner(() => okResult("Name\nNVIDIA GeForce RTX 4070\n"));
    const fp = await computeGpuFingerprint(runner, "win32");
    expect(fp).toBe(sha256("Name\nNVIDIA GeForce RTX 4070\n"));
    expect(runner.calls[0]).toEqual({
      bin: "wmic",
      args: ["path", "win32_VideoController", "get", "name"],
      options: { timeoutMs: 10_000 },
    });
  });

  it("unknown platform -> '' without attempting any command", async () => {
    const runner = createFakeRunner(() => okResult("should never be called"));
    const fp = await computeGpuFingerprint(runner, "aix");
    expect(fp).toBe("");
    expect(runner.calls).toEqual([]);
  });

  it("non-zero exit -> '' (best-effort, never throws)", async () => {
    const runner = createFakeRunner(() => failResult(1, "command not found"));
    expect(await computeGpuFingerprint(runner, "linux")).toBe("");
  });

  it("timeout -> ''", async () => {
    const runner = createFakeRunner(() => timeoutResult());
    expect(await computeGpuFingerprint(runner, "darwin")).toBe("");
  });

  it("linux: lspci exits 0 but zero VGA/3D lines match -> '' (not a hash of nothing)", async () => {
    const runner = createFakeRunner(() => okResult("00:00.0 Host bridge: Intel Corporation Device 1234\n"));
    expect(await computeGpuFingerprint(runner, "linux")).toBe("");
  });

  it("a thrown runner still degrades to '' rather than propagating", async () => {
    const runner = createFakeRunner(() => {
      throw new Error("boom");
    });
    expect(await computeGpuFingerprint(runner, "darwin")).toBe("");
  });
});
