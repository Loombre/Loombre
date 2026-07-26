// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Playback matrix burn-up runner (docs/PLAYBACK.md §11 step 1, STATE.md
 * P3.1/P3.2/P3.9d). Runs ONLY via `pnpm --filter @loombre/playback-engine
 * run test:matrix` (vitest.matrix.config.ts) — excluded from the default
 * `test` project so `pnpm gate` stays green. See matrix-meta.spec.ts for
 * the gate-side manifest-sync assertions.
 *
 * `matrix/burnup.json` is the single source of truth for each case's
 * CURRENT expected status. For every case this suite:
 *   1. Calls plan() and derives an actual status:
 *      - throws NotImplementedError => "red" (the pre-Stage-A wall).
 *      - returns a plan whose decision+reasons (and, when present,
 *        subtitleStrategy/container/ladderMaxVideoBitrateBps/ladder) match
 *        the case file's `expect` block exactly => "green".
 *      - returns a plan that does NOT fully match => also "red". This is
 *        deliberate, not laxity: stages land one at a time (STATE.md P3.1)
 *        with not-yet-landed stages passing through permissively, so a
 *        case whose expectation depends on a later stage MUST be allowed
 *        to mismatch until that stage's PR greens it. The output's
 *        structural validity is separately enforced for the whole input
 *        space by the totality property (properties.spec.ts) from the
 *        first green onward.
 *      - a throw that is NOT NotImplementedError is a HARD test failure
 *        regardless of the manifest — plan() is total (§0/§10); no
 *        manifest state ever tolerates a crash.
 *   2. Asserts the case's actual status === its manifest status, with the
 *      full expect-assertion diff replayed when a manifest-green case
 *      mismatches. Greening a case (or a green case regressing) without
 *      editing burnup.json in the same PR fails here — this is STATE.md
 *      P3.2's regression law made mechanical. The manifest never launders
 *      an incorrect implementation into a green case: "green" in the
 *      manifest re-runs the full fatal assertions.
 *   3. A separate check asserts burnup.json lists EXACTLY the case files
 *      on disk — no unlisted cases, no phantom manifest entries.
 * `afterAll` prints a one-line burn-up summary
 * (`matrix burn-up: N green / M red / T total`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { plan, NotImplementedError } from "../src/index.js";
import type { PlaybackPlan } from "../src/types.js";
import { loadBurnupManifest } from "./lib/burnup.js";
import { listCaseFiles, loadAllCases } from "./lib/load-cases.js";

const cases = loadAllCases();
const manifest = loadBurnupManifest();

let greenCount = 0;
let redCount = 0;

describe("playback matrix burn-up (docs/PLAYBACK.md §11 step 1)", () => {
  it("burnup.json covers exactly the case files on disk (no unlisted cases, no phantom entries)", () => {
    const files = listCaseFiles();
    expect(Object.keys(manifest).slice().sort()).toEqual(files.slice().sort());
  });

  for (const matrixCase of cases) {
    it(`${matrixCase.file}: ${matrixCase.name}`, () => {
      const expected = matrixCase.expect;
      const expectedStatus = manifest[matrixCase.file];
      expect(expectedStatus, `${matrixCase.file}: not listed in matrix/burnup.json`).toBeDefined();

      let threwNotImplemented = false;
      let result: PlaybackPlan | undefined;
      try {
        result = plan(matrixCase.input);
      } catch (err) {
        if (!(err instanceof NotImplementedError)) {
          const gotMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          throw new Error(
            `case "${matrixCase.name}" (${matrixCase.file}): plan() threw a non-NotImplementedError — ` +
              `plan() is total (docs/PLAYBACK.md §0 law 3 / §10 property 3); no manifest state tolerates ` +
              `a crash — got ${gotMessage}`,
          );
        }
        threwNotImplemented = true;
      }

      const assertCaseExpectations = (produced: PlaybackPlan): void => {
        expect(produced.decision).toBe(expected.decision);
        expect(produced.reasons.map((r) => r.code)).toEqual(expected.reasons);
        if (expected.subtitleStrategy !== undefined) {
          expect(produced.subtitle.strategy).toBe(expected.subtitleStrategy);
        }
        if (expected.container !== undefined) {
          expect(produced.container).toBe(expected.container);
        }
        if (expected.ladderMaxVideoBitrateBps !== undefined) {
          const maxRungBitrate = Math.max(0, ...produced.ladder.map((rung) => rung.videoBitrateBps));
          expect(maxRungBitrate).toBeLessThanOrEqual(expected.ladderMaxVideoBitrateBps);
        }
        if (expected.ladder !== undefined) {
          expect(produced.ladder).toEqual(expected.ladder);
        }
      };

      const matchesExpectations = (produced: PlaybackPlan): boolean => {
        try {
          assertCaseExpectations(produced);
          return true;
        } catch {
          return false;
        }
      };

      // Three-way actual status (see the header comment): NotImplementedError
      // OR a mismatching plan both count "red" — later-stage cases mismatch
      // by design until their stage lands (STATE.md P3.1). "Green" requires
      // the full expectation to hold.
      const actualStatus: "green" | "red" =
        !threwNotImplemented && matchesExpectations(result!) ? "green" : "red";
      if (actualStatus === "green") greenCount++;
      else redCount++;

      if (expectedStatus === "green" && actualStatus === "red") {
        if (threwNotImplemented) {
          throw new Error(
            `${matrixCase.file}: burnup.json says "green" but plan() still throws NotImplementedError — ` +
              `either plan() regressed or burnup.json was flipped prematurely (STATE.md P3.2)`,
          );
        }
        // Replay the fatal assertions so the failure shows the exact
        // decision/reasons diff, not just a status-mismatch one-liner.
        assertCaseExpectations(result!);
      }

      expect(
        actualStatus,
        `${matrixCase.file}: burnup.json says "${expectedStatus}" but plan() actually went "${actualStatus}" — ` +
          `greening or regressing a case requires editing matrix/burnup.json in the same PR (STATE.md P3.2)`,
      ).toBe(expectedStatus);
    });
  }

  afterAll(() => {
    // process.stdout.write, not console.log: vitest's console interception
    // swallows hook-time console output, and this line is the burn-up
    // number CI logs and STATE.md's table are checked against.
    process.stdout.write(`\nmatrix burn-up: ${greenCount} green / ${redCount} red / ${cases.length} total\n`);
  });
});
