// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fixture-corpus test runner for the filename/folder parser — docs/PLAN.md
 * §8.1, STATE.md P1.4.
 *
 * Walks every `*.json` file in `fixtures/`, dispatches each case to the
 * matching parse function by its `kind`, and asserts DEEP equality against
 * `expected` (the full object, or `null`). This file makes no per-path
 * assertions of its own — the fixtures ARE the spec; see the fixture files'
 * `note` fields for the rule each case documents.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyAuxiliary } from "../../src/scan/parse/auxiliary.js";
import { parseMoviePath } from "../../src/scan/parse/movie.js";
import { parseMusicPath } from "../../src/scan/parse/music.js";
import { parseTvPath } from "../../src/scan/parse/tv.js";
import type { AuxiliaryKind, MovieGuess, MusicGuess, TvGuess } from "../../src/scan/parse/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

type FixtureKind = "movie" | "tv" | "music" | "auxiliary";

interface FixtureCase {
  path: string;
  kind: FixtureKind;
  expected: MovieGuess | TvGuess | MusicGuess | AuxiliaryKind | null;
  note?: string;
}

function loadFixtureFile(file: string): FixtureCase[] {
  const raw = readFileSync(join(FIXTURES_DIR, file), "utf8");
  return JSON.parse(raw) as FixtureCase[];
}

const fixtureFiles = readdirSync(FIXTURES_DIR)
  .filter((entry) => entry.endsWith(".json"))
  .sort();

// Mission minimums (STATE.md P1.4 / the parser-builder brief): the fixture
// corpus is the exit bar, not a suggestion.
const MINIMUMS: Record<"movie" | "tv" | "music", number> = { movie: 120, tv: 150, music: 60 };

function runCase(c: FixtureCase): unknown {
  switch (c.kind) {
    case "movie":
      return parseMoviePath(c.path);
    case "tv":
      return parseTvPath(c.path);
    case "music":
      return parseMusicPath(c.path);
    case "auxiliary":
      return classifyAuxiliary(c.path);
  }
}

describe("filename/folder parser fixture corpus", () => {
  for (const file of fixtureFiles) {
    const cases = loadFixtureFile(file);
    describe(file, () => {
      for (const c of cases) {
        const label = c.note ? `${JSON.stringify(c.path)} — ${c.note}` : JSON.stringify(c.path);
        it(label, () => {
          expect(runCase(c)).toStrictEqual(c.expected);
        });
      }
    });
  }

  it("meets the P1.4 fixture-count minimums (movie >= 120, tv >= 150, music >= 60)", () => {
    const counts: Record<string, number> = { movie: 0, tv: 0, music: 0, auxiliary: 0 };
    for (const file of fixtureFiles) {
      for (const c of loadFixtureFile(file)) {
        counts[c.kind] = (counts[c.kind] ?? 0) + 1;
      }
    }
    for (const kind of Object.keys(MINIMUMS) as (keyof typeof MINIMUMS)[]) {
      expect(counts[kind], `${kind} fixture count`).toBeGreaterThanOrEqual(MINIMUMS[kind]);
    }
  });

  it("every fixture file is non-empty and every case has a non-empty path string", () => {
    for (const file of fixtureFiles) {
      const cases = loadFixtureFile(file);
      expect(cases.length, file).toBeGreaterThan(0);
      for (const c of cases) {
        expect(typeof c.path, `${file}: ${JSON.stringify(c)}`).toBe("string");
      }
    }
  });
});
