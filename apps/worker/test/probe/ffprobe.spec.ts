// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveFfmpeg, resolveFfprobe, runFfprobe } from "../../src/probe/ffprobe.js";
import { ProbeError } from "../../src/probe/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_DIR = join(__dirname, "fixtures", "bin");
// A real fake binary, cross-platform: shebang script on POSIX, a .cmd
// wrapper on Windows (Node's spawn() doesn't interpret shebangs there).
const FAKE_FFPROBE = process.platform === "win32" ? join(BIN_DIR, "fake-ffprobe.cmd") : join(BIN_DIR, "fake-ffprobe.mjs");

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(() => {
  resetEnv();
});

describe("resolveFfprobe / resolveFfmpeg", () => {
  it("resolves from LOOMBRE_FFPROBE when it points at an executable file", () => {
    process.env["LOOMBRE_FFPROBE"] = FAKE_FFPROBE;
    const result = resolveFfprobe();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binary.source).toBe("env");
      expect(result.binary.path).toBe(FAKE_FFPROBE);
    }
  });

  it("resolves ffmpeg from LOOMBRE_FFMPEG independently of LOOMBRE_FFPROBE", () => {
    process.env["LOOMBRE_FFMPEG"] = FAKE_FFPROBE;
    const result = resolveFfmpeg();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binary.source).toBe("env");
    }
  });

  it("returns a typed ProbeError (never throws) when LOOMBRE_FFPROBE points nowhere", () => {
    process.env["LOOMBRE_FFPROBE"] = "/definitely/not/a/real/path/ffprobe-xyz";
    const result = resolveFfprobe();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ProbeError);
      expect(result.error.code).toBe("binary-not-found");
    }
  });

  it("returns a typed ProbeError when neither the env var nor PATH has the binary", () => {
    delete process.env["LOOMBRE_FFPROBE"];
    process.env["PATH"] = ""; // empty PATH guarantees a PATH-scan miss
    process.env["Path"] = "";
    const result = resolveFfprobe();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("binary-not-found");
      expect(result.error.message).toContain("ffprobe");
    }
  });
});

describe("runFfprobe", () => {
  beforeEach(() => {
    delete process.env["FAKE_FFPROBE_MODE"];
  });

  it("parses stdout JSON on a successful exit", async () => {
    process.env["FAKE_FFPROBE_MODE"] = "success";
    const result = await runFfprobe("irrelevant-path.mp4", { ffprobePath: FAKE_FFPROBE });
    expect(result.format?.format_name).toBe("mp4");
    expect(result.format?.duration).toBe("1.500000");
  });

  it("rejects with a typed ProbeError('nonzero-exit') and attaches a stderr tail", async () => {
    process.env["FAKE_FFPROBE_MODE"] = "nonzero";
    await expect(runFfprobe("bad.mp4", { ffprobePath: FAKE_FFPROBE })).rejects.toMatchObject({
      code: "nonzero-exit",
    });
    try {
      await runFfprobe("bad.mp4", { ffprobePath: FAKE_FFPROBE });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProbeError);
      const probeErr = err as ProbeError;
      expect(probeErr.details?.["stderrTail"]).toContain("simulated probe failure");
    }
  });

  it("rejects with a typed ProbeError('invalid-json') on unparseable stdout", async () => {
    process.env["FAKE_FFPROBE_MODE"] = "badjson";
    await expect(runFfprobe("bad.mp4", { ffprobePath: FAKE_FFPROBE })).rejects.toMatchObject({
      code: "invalid-json",
    });
  });

  it("rejects with a typed ProbeError('timeout') and kills a hung process", async () => {
    process.env["FAKE_FFPROBE_MODE"] = "hang";
    await expect(
      runFfprobe("hung.mp4", { ffprobePath: FAKE_FFPROBE, timeoutMs: 150 }),
    ).rejects.toMatchObject({ code: "timeout" });
  }, 5000);

  it("rejects with a typed ProbeError('spawn-failed') when the binary path doesn't exist", async () => {
    await expect(
      runFfprobe("x.mp4", { ffprobePath: "/definitely/not/a/real/ffprobe-binary" }),
    ).rejects.toMatchObject({ code: "spawn-failed" });
  });

  it("resolves the binary via resolveFfprobe() when ffprobePath is omitted", async () => {
    process.env["LOOMBRE_FFPROBE"] = FAKE_FFPROBE;
    process.env["FAKE_FFPROBE_MODE"] = "success";
    const result = await runFfprobe("via-env.mp4");
    expect(result.format?.format_name).toBe("mp4");
  });

  it("propagates the typed binary-not-found error instead of spawning anything", async () => {
    delete process.env["LOOMBRE_FFPROBE"];
    process.env["PATH"] = "";
    process.env["Path"] = "";
    await expect(runFfprobe("no-binary.mp4")).rejects.toMatchObject({ code: "binary-not-found" });
  });
});
