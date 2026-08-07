// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/hwcaps/conformance.spec.ts
//
// P3.3 exit-gate item (STATE.md, Phase 3 §11 step 5 binding constraint 6):
// "the probe implementation must reproduce the fixture schema exactly."
// Loads packages/playback-engine/matrix/fixtures/caps.yaml with this
// module's own minimal parser (caps-yaml.ts) and runs BOTH every fixture
// set AND a synthetic probe-produced `VerifiedCapabilities` object through
// the ONE shared structural validator (schema.ts) — proving there is no
// second, silently-drifted notion of "what a VerifiedCapabilities object
// looks like" anywhere in this codebase.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFakeRunner, createFakeProbeFile, fakeClock, okResult } from "./helpers.js";
import { runProbeBattery } from "../../src/hwcaps/battery.js";
import { parseCapsYaml } from "../../src/hwcaps/caps-yaml.js";
import { toVerifiedCapabilities } from "../../src/hwcaps/report.js";
import { validateVerifiedCapabilities } from "../../src/hwcaps/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPS_YAML_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "playback-engine",
  "matrix",
  "fixtures",
  "caps.yaml",
);

describe("caps.yaml parser + shared schema conformance", () => {
  const yamlText = readFileSync(CAPS_YAML_PATH, "utf8");
  const fixtures = parseCapsYaml(yamlText);

  it("parses at least the four P3.3-named sets plus the Stage-G additive fixtures", () => {
    for (const name of [
      "software-only",
      "full-hw",
      "encode-only",
      "macos-vt",
      "qsv-opencl",
      "qsv-vulkan-only",
      "vaapi-opencl",
      "vaapi-vulkan-only",
      "hw-no-tonemap",
      "dual-hw-tonemap-fallthrough",
      "linux-platform-order",
      "windows-platform-order",
      "decode-only-guard",
    ]) {
      expect(fixtures[name], `expected fixture set "${name}"`).toBeDefined();
      expect(fixtures[name]!.backends.length).toBeGreaterThan(0);
    }
  });

  it("the W1/D-1 'empty' fixture exists, has ZERO backends, and is itself schema-valid (empty set is first-class)", () => {
    expect(fixtures["empty"], "expected fixture set \"empty\"").toBeDefined();
    expect(fixtures["empty"]!.backends).toHaveLength(0);
    const result = validateVerifiedCapabilities(fixtures["empty"]);
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("every fixture set's backends list is non-empty (except the deliberate 'empty' set) and every backend row has all four fields", () => {
    for (const [name, set] of Object.entries(fixtures)) {
      if (name === "empty") continue; // W1/D-1: the one deliberately-empty set, asserted above
      expect(set.backends.length, `${name} should have >=1 backend`).toBeGreaterThan(0);
      for (const backend of set.backends) {
        expect(typeof backend.backend, `${name}: backend name`).toBe("string");
        expect(Array.isArray(backend.decode), `${name}/${backend.backend}: decode`).toBe(true);
        expect(Array.isArray(backend.encode), `${name}/${backend.backend}: encode`).toBe(true);
        expect(Array.isArray(backend.toneMap), `${name}/${backend.backend}: toneMap`).toBe(true);
        expect(typeof backend.verifiedAtMs, `${name}/${backend.backend}: verifiedAtMs`).toBe("number");
      }
    }
  });

  it("EVERY fixture set validates against the shared §2.5 structural validator", () => {
    for (const [name, set] of Object.entries(fixtures)) {
      const result = validateVerifiedCapabilities(set);
      expect(result.valid, `${name}: ${JSON.stringify(result.violations)}`).toBe(true);
    }
  });

  it("software-only's fixture backend list ends with 'software' (matches every other set's own convention)", () => {
    for (const [name, set] of Object.entries(fixtures)) {
      if (name === "empty") continue; // W1/D-1: zero backends by design — no last entry to check
      expect(set.backends.at(-1)!.backend, `${name} should end with a fallback tier`).toBe("software");
    }
  });

  it("a real probe-produced VerifiedCapabilities object validates against the EXACT SAME validator (the P3.3 exit-gate proof)", async () => {
    // A fake battery run (never touches real ffmpeg) exercising every
    // outcome kind (pass/fail/timeout/skipped) across decode/encode/
    // toneMap, so the produced shape isn't a trivial all-empty object.
    const runner = createFakeRunner((call) => {
      if (call.args.includes("-encoders")) {
        return okResult(" V..... libx264              (codec h264)\n V..... libx265              (codec hevc)\n");
      }
      if (call.args.includes("-hwaccel")) {
        // decode test — pretend videotoolbox genuinely engaged for h264.
        return okResult("", "Reinit context to 320x240, pix_fmt: videotoolbox_vld\nframe=   50 fps=0.0\n");
      }
      // source generation / encode / tonemap
      return okResult("", "frame=   50 fps=0.0\n");
    });
    const probeFile = createFakeProbeFile((filePath) => {
      if (filePath.includes("encode-videotoolbox-h264")) return { codecName: "h264", colorTransfer: null };
      if (filePath.includes("tonemap-videotoolbox-videotoolbox")) return { codecName: "h264", colorTransfer: "bt709" };
      return null;
    });

    const result = await runProbeBattery({
      backends: ["videotoolbox", "software"],
      runCommand: runner,
      probeFile,
      ffmpegPath: "/fake/ffmpeg",
      workDir: "/fake/workdir",
      clock: fakeClock(),
      encoders: new Set(["libx264", "libx265"]),
    });

    const verified = toVerifiedCapabilities(result);
    const validation = validateVerifiedCapabilities(verified);
    expect(validation.valid, JSON.stringify(validation.violations)).toBe(true);

    // Reproduces the fixture schema EXACTLY — same top-level shape, same
    // per-backend field set, backend order preserved.
    expect(Object.keys(verified)).toEqual(["backends"]);
    expect(verified.backends.map((b) => b.backend)).toEqual(["videotoolbox", "software"]);
    for (const backend of verified.backends) {
      expect(Object.keys(backend).sort()).toEqual(["backend", "decode", "encode", "toneMap", "verifiedAtMs"].sort());
    }
  });
});
