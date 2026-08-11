// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Golden-file suite for src/args/builder.ts (docs/PLAYBACK.md §6, Phase 3
 * §11 step 4's 25 scenarios + step 7b fix F4's two vaapi burn-in scenarios
 * + the step-7 owner-smoke VT tone-map real-execution fix's hybrid
 * scenario + the four scenarios that landed with interpretation D's
 * generalization to every §8.3 hw backend + the open-GOP HEVC seek-restart
 * strip pair (interpretation K, 2026-08-10) + the four Dolby Vision strip
 * scenarios (interpretation L, LD-3/LD-15, 2026-08-11) = exactly 38
 * scenario files
 * under test/goldens/
 * (test/goldens/scenarios.ts constructs the inputs in test
 * code; test/goldens/<id>.json are the checked-in snapshots — full deep
 * equality, never a partial/subset match). "Golden-file tests snapshot the
 * token form" (docs/PLAYBACK.md §6) — every snapshot's `args` is the exact
 * literal `string[]` `buildFfmpegArgs` must keep producing; any REAL flag
 * change requires editing the matching snapshot in the same PR (mirrors the
 * matrix's own regression law, docs/PLAYBACK.md §10 / STATE.md P3.2).
 *
 * Each snapshot is `{ scenario, args }` — `scenario` doubles as the file's
 * HEADER comment (JSON has no comment syntax) and is cross-checked against
 * scenarios.ts's own `scenario` string so the two never drift silently.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFfmpegArgs } from "../src/args/builder.js";
import { GOLDEN_SCENARIOS } from "./goldens/scenarios.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDENS_DIR = join(__dirname, "goldens");

interface GoldenSnapshot {
  scenario: string;
  args: string[];
}

function loadSnapshot(id: string): GoldenSnapshot {
  const raw = readFileSync(join(GOLDENS_DIR, `${id}.json`), "utf8");
  return JSON.parse(raw) as GoldenSnapshot;
}

describe("ffmpeg arg builder goldens (docs/PLAYBACK.md §6, exactly 38 scenarios)", () => {
  it("exactly 38 scenarios are defined (step 4's 25 + step 7b F4's two vaapi burn-in goldens + the VT tone-map hybrid golden + interpretation D's four backend-agnostic hw tone-map goldens + interpretation K's open-GOP seek-restart strip pair + interpretation L's four Dolby Vision strip goldens)", () => {
    expect(GOLDEN_SCENARIOS).toHaveLength(38);
  });

  it("every scenario id is unique", () => {
    const ids = GOLDEN_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const s of GOLDEN_SCENARIOS) {
    it(`${s.id}: ${s.scenario}`, () => {
      const snapshot = loadSnapshot(s.id);
      // The snapshot's own header field must still name this exact scenario
      // — catches a snapshot silently going stale relative to scenarios.ts.
      expect(snapshot.scenario, `${s.id}: snapshot header drifted from scenarios.ts`).toBe(s.scenario);

      const produced = buildFfmpegArgs(s.input, s.planShape, s.options);
      // Full deep equality with a legible diff (vitest's own array diff) —
      // never a subset/partial match.
      expect(produced).toEqual(snapshot.args);

      // Every produced arg is a string (ffmpegArgs' own §5 contract).
      expect(produced.every((a) => typeof a === "string")).toBe(true);
    });
  }

  it("determinism: every scenario produces byte-identical args on a second run", () => {
    for (const s of GOLDEN_SCENARIOS) {
      const first = buildFfmpegArgs(structuredClone(s.input), structuredClone(s.planShape), { ...s.options });
      const second = buildFfmpegArgs(structuredClone(s.input), structuredClone(s.planShape), { ...s.options });
      expect(second, s.id).toEqual(first);
    }
  });
});
