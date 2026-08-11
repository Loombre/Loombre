// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Matrix meta-assertions (STATE.md D22, P3.9d) — GREEN today, runs as part
 * of the default `test` project (`pnpm gate`). Proves the burn-up manifest
 * (matrix/burnup.json) and case files are in sync and well-formed, WITHOUT
 * asserting anything about individual case *decisions* — that is
 * matrix.spec.ts's job (`pnpm test:matrix`), which is deliberately NOT part
 * of the gate:
 *   (a) case-count === burnup.json's total entry count, and burnup.json
 *       lists exactly the case files on disk (no unlisted cases, no
 *       phantom manifest entries — matrix.spec.ts re-asserts this too,
 *       independently, since it's the one that would actually be
 *       inconvenienced by a mismatch).
 *   (b) every case validates against the case schema (decision enum, every
 *       expected reason code drawn from the closed docs/PLAYBACK.md §4
 *       enum — the `hw-encoder-selected:*` / `software-fallback:*`
 *       families validated by prefix — this also transitively proves every
 *       case's `{ fixture: "<file>.<key>" }` references resolve, since
 *       loadAllCases() throws immediately on a dangling reference).
 *   (c) every case's input satisfies structural sanity (selection indexes
 *       reference existing streams or are null).
 *   (d) the new caps.yaml fixture sets (STATE.md P3.3: full-hw, encode-only,
 *       macos-vt, alongside software-only) validate against the §2.5
 *       VerifiedCapabilities shape.
 *   (e) the Phase-0 "plan() throws NotImplementedError" assertion (STATE.md
 *       D22) is now CONDITIONAL on the manifest (P3.9d): it holds iff 0
 *       cases are green. The day Stage A greens case 001, this assertion
 *       retires itself automatically — no meta-test edit required, only
 *       the burnup.json edit that PR already has to make.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { NotImplementedError, plan } from "../src/index.js";
import {
  BLOCKING_REASON_CODES,
  FIXED_INFORMATIONAL_REASON_CODES,
  type PlanReasonCode,
} from "../src/reasons.js";
import { countBurnupStatuses, loadBurnupManifest } from "./lib/burnup.js";
import { listCaseFiles, loadAllCases } from "./lib/load-cases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

const VALID_DECISIONS = new Set(["direct-play", "direct-stream", "remux", "transcode"]);
const VALID_SUBTITLE_STRATEGIES = new Set(["none", "embed", "hls-vtt", "burn-in"]);
const VALID_CONTAINERS = new Set(["source", "fmp4-hls", "ts-hls", "mp4"]);
const VALID_LADDER_CODECS = new Set(["h264", "hevc"]);

function isValidReasonCode(code: string): code is PlanReasonCode {
  if ((BLOCKING_REASON_CODES as readonly string[]).includes(code)) return true;
  if ((FIXED_INFORMATIONAL_REASON_CODES as readonly string[]).includes(code)) return true;
  if (code.startsWith("hw-encoder-selected:")) return true;
  if (code.startsWith("software-fallback:")) return true;
  return false;
}

describe("matrix-meta (burn-up manifest sync + case schema)", () => {
  it("case-count === burnup.json total, and every case file is listed exactly once", () => {
    const files = listCaseFiles();
    const manifest = loadBurnupManifest();
    const manifestFiles = Object.keys(manifest);

    expect(manifestFiles.slice().sort()).toEqual(files.slice().sort());

    const cases = loadAllCases();
    const { total } = countBurnupStatuses(manifest);
    expect(files).toHaveLength(total);
    expect(cases).toHaveLength(total);
    for (const matrixCase of cases) {
      expect(matrixCase.input).toBeTruthy();
      expect(matrixCase.expect).toBeTruthy();
    }
  });

  it("every case validates against the case schema", () => {
    const cases = loadAllCases();
    for (const matrixCase of cases) {
      expect(typeof matrixCase.name).toBe("string");
      expect(matrixCase.name.length).toBeGreaterThan(0);
      expect(typeof matrixCase.why).toBe("string");
      expect(matrixCase.why.length).toBeGreaterThan(0);

      expect(VALID_DECISIONS.has(matrixCase.expect.decision)).toBe(true);
      expect(Array.isArray(matrixCase.expect.reasons)).toBe(true);
      for (const code of matrixCase.expect.reasons) {
        expect(isValidReasonCode(code), `${matrixCase.file}: unknown reason code "${code}"`).toBe(
          true,
        );
      }

      if (matrixCase.expect.subtitleStrategy !== undefined) {
        expect(VALID_SUBTITLE_STRATEGIES.has(matrixCase.expect.subtitleStrategy)).toBe(true);
      }
      if (matrixCase.expect.container !== undefined) {
        expect(
          VALID_CONTAINERS.has(matrixCase.expect.container),
          `${matrixCase.file}: invalid expect.container "${matrixCase.expect.container}"`,
        ).toBe(true);
      }
      if (matrixCase.expect.ladderMaxVideoBitrateBps !== undefined) {
        expect(typeof matrixCase.expect.ladderMaxVideoBitrateBps).toBe("number");
        expect(matrixCase.expect.ladderMaxVideoBitrateBps).toBeGreaterThan(0);
      }
      if (matrixCase.expect.ladder !== undefined) {
        expect(Array.isArray(matrixCase.expect.ladder), `${matrixCase.file}: expect.ladder must be an array`).toBe(
          true,
        );
        for (const rung of matrixCase.expect.ladder) {
          expect(
            typeof rung.heightPx === "number" && rung.heightPx > 0,
            `${matrixCase.file}: expect.ladder rung has an invalid heightPx ${JSON.stringify(rung.heightPx)}`,
          ).toBe(true);
          expect(
            typeof rung.videoBitrateBps === "number" && rung.videoBitrateBps > 0,
            `${matrixCase.file}: expect.ladder rung has an invalid videoBitrateBps ${JSON.stringify(rung.videoBitrateBps)}`,
          ).toBe(true);
          expect(
            typeof rung.audioBitrateBps === "number" && rung.audioBitrateBps > 0,
            `${matrixCase.file}: expect.ladder rung has an invalid audioBitrateBps ${JSON.stringify(rung.audioBitrateBps)}`,
          ).toBe(true);
          expect(
            VALID_LADDER_CODECS.has(rung.codec),
            `${matrixCase.file}: expect.ladder rung has an invalid codec ${JSON.stringify(rung.codec)}`,
          ).toBe(true);
        }
      }
    }
  });

  it("every case's input satisfies structural sanity", () => {
    const cases = loadAllCases();
    for (const matrixCase of cases) {
      const { input } = matrixCase;

      expect(input.media, `${matrixCase.file}: missing media`).toBeTruthy();
      expect(Array.isArray(input.media.video)).toBe(true);
      expect(Array.isArray(input.media.audio)).toBe(true);
      expect(Array.isArray(input.media.subtitle)).toBe(true);
      // Finding H (opus review, 2026-08-10): `VideoStream.openGop` (§2.1) is
      // REQUIRED, never optional — load-cases.ts's `as PlanInput` cast has no
      // runtime validation, so a case YAML that omits the field would
      // silently carry `openGop: undefined` at runtime instead of the
      // conservative `false` default every real extraction path collapses a
      // DB NULL to. Closes the corpus against regressing back to that state
      // (all 513 pre-existing cases were mechanically backfilled with
      // `openGop: false` the same day this assertion landed).
      for (const stream of input.media.video) {
        expect(
          typeof stream.openGop === "boolean",
          `${matrixCase.file}: video stream index ${stream.index} is missing a boolean openGop field`,
        ).toBe(true);
      }

      expect(input.device, `${matrixCase.file}: missing device`).toBeTruthy();
      expect(Array.isArray(input.device.directPlayContainers)).toBe(true);
      expect(Array.isArray(input.device.video)).toBe(true);
      expect(Array.isArray(input.device.audio)).toBe(true);

      expect(input.network, `${matrixCase.file}: missing network`).toBeTruthy();
      expect(typeof input.network.maxBitrateBps).toBe("number");
      expect(typeof input.network.isLocal).toBe("boolean");

      expect(input.policy, `${matrixCase.file}: missing policy`).toBeTruthy();
      expect(Array.isArray(input.policy.ladderRungs)).toBe(true);

      expect(input.caps, `${matrixCase.file}: missing caps`).toBeTruthy();
      expect(Array.isArray(input.caps.backends)).toBe(true);

      expect(input.selection, `${matrixCase.file}: missing selection`).toBeTruthy();
      expect(["stream", "download"]).toContain(input.mode);

      // Selection indexes must reference existing streams (or be null).
      if (input.selection.videoStreamIndex !== null) {
        expect(input.media.video.some((v) => v.index === input.selection.videoStreamIndex)).toBe(
          true,
        );
      }
      if (input.selection.audioStreamIndex !== null) {
        expect(input.media.audio.some((a) => a.index === input.selection.audioStreamIndex)).toBe(
          true,
        );
      }
      if (input.selection.subtitleStreamIndex !== null) {
        expect(
          input.media.subtitle.some((s) => s.index === input.selection.subtitleStreamIndex),
        ).toBe(true);
      }
    }
  });

  it("caps.yaml fixture sets (STATE.md P3.3) validate against the §2.5 VerifiedCapabilities shape", () => {
    const VALID_BACKENDS = new Set(["videotoolbox", "qsv", "vaapi", "nvenc", "amf", "d3d11va", "software"]);
    const VALID_DECODE_CODECS = new Set(["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4", "unknown"]);
    const VALID_ENCODE_CODECS = new Set(["h264", "hevc", "av1"]);
    const VALID_TONE_MAP = new Set(["opencl", "vulkan", "videotoolbox", "cuda", "none"]);
    const EXPECTED_NAMED_SETS = ["software-only", "full-hw", "encode-only", "macos-vt"];

    const raw = readFileSync(join(FIXTURES_DIR, "caps.yaml"), "utf8");
    const doc = parse(raw) as Record<string, { backends: unknown }>;

    for (const name of EXPECTED_NAMED_SETS) {
      expect(doc, `caps.yaml missing named set "${name}"`).toHaveProperty(name);
    }

    for (const [setName, caps] of Object.entries(doc)) {
      expect(Array.isArray(caps.backends), `${setName}.backends must be an array`).toBe(true);
      for (const backendEntry of caps.backends as Array<Record<string, unknown>>) {
        expect(
          typeof backendEntry["backend"] === "string" && VALID_BACKENDS.has(backendEntry["backend"] as string),
          `${setName}: invalid backend ${JSON.stringify(backendEntry["backend"])}`,
        ).toBe(true);

        expect(
          Array.isArray(backendEntry["decode"]),
          `${setName}/${String(backendEntry["backend"])}.decode must be an array`,
        ).toBe(true);
        for (const codec of backendEntry["decode"] as string[]) {
          expect(
            VALID_DECODE_CODECS.has(codec),
            `${setName}/${String(backendEntry["backend"])}: invalid decode codec "${codec}"`,
          ).toBe(true);
        }

        expect(
          Array.isArray(backendEntry["encode"]),
          `${setName}/${String(backendEntry["backend"])}.encode must be an array`,
        ).toBe(true);
        for (const codec of backendEntry["encode"] as string[]) {
          expect(
            VALID_ENCODE_CODECS.has(codec),
            `${setName}/${String(backendEntry["backend"])}: invalid encode codec "${codec}"`,
          ).toBe(true);
        }

        expect(
          Array.isArray(backendEntry["toneMap"]),
          `${setName}/${String(backendEntry["backend"])}.toneMap must be an array`,
        ).toBe(true);
        for (const method of backendEntry["toneMap"] as string[]) {
          expect(
            VALID_TONE_MAP.has(method),
            `${setName}/${String(backendEntry["backend"])}: invalid toneMap "${method}"`,
          ).toBe(true);
        }

        expect(
          typeof backendEntry["verifiedAtMs"],
          `${setName}/${String(backendEntry["backend"])}.verifiedAtMs must be a number`,
        ).toBe("number");
      }
    }
  });

  it('"plan() throws NotImplementedError" retires automatically once burnup.json has any green case (P3.9d)', () => {
    const manifest = loadBurnupManifest();
    const { green } = countBurnupStatuses(manifest);
    const [firstCase] = loadAllCases();
    if (!firstCase) throw new Error("expected at least one matrix case to exist");

    let threwNotImplemented = false;
    try {
      plan(firstCase.input);
    } catch (err) {
      if (err instanceof NotImplementedError) {
        threwNotImplemented = true;
      } else {
        throw err;
      }
    }

    expect(
      green === 0,
      `burnup.json has ${green} green case(s) but plan() ${
        threwNotImplemented ? "still threw" : "did not throw"
      } NotImplementedError on ${firstCase.file}'s input — either plan() regressed or burnup.json needs updating`,
    ).toBe(threwNotImplemented);
  });
});
