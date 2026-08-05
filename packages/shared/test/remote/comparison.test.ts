// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/remote/comparison.test.ts
//
// STATE.md "Loombre Remote ..." (R8's honest comparison card, Batch-1 lane
// U1). Content-completeness tests only — every (path, axis) cell exists and
// is real prose, never an empty placeholder — this module carries the
// SINGLE source of comparison-card content (see comparison.ts's header: the
// UI and the ops docs both read from here rather than duplicating copy).

import { describe, expect, it } from "vitest";
import { COMPARISON_AXES, COMPARISON_AXIS_LABELS, PATH_COMPARISON, comparisonRows, type ComparisonAxis } from "../../src/remote/comparison.js";
import type { PathId } from "../../src/remote/wizard-state.js";

const ALL_PATHS: readonly PathId[] = ["remote", "tunnel", "direct"];

describe("COMPARISON_AXES — the closed R8 axis list", () => {
  it("is exactly these 4 axes", () => {
    expect([...COMPARISON_AXES].sort()).toEqual(["attackSurface", "difficulty", "thirdParties", "whatBreaksWhen"].sort());
  });

  it("every axis has a non-empty human-facing label", () => {
    for (const axis of COMPARISON_AXES) {
      expect(COMPARISON_AXIS_LABELS[axis].trim().length).toBeGreaterThan(0);
    }
  });
});

describe("PATH_COMPARISON — content completeness (every path x axis, no empty cells)", () => {
  it("covers exactly remote/tunnel/direct — no 'none', nothing missing", () => {
    expect(Object.keys(PATH_COMPARISON).sort()).toEqual([...ALL_PATHS].sort());
  });

  it("every path has every axis, and every cell is real prose (not empty/whitespace)", () => {
    for (const path of ALL_PATHS) {
      for (const axis of COMPARISON_AXES) {
        const cell = PATH_COMPARISON[path][axis];
        expect(typeof cell).toBe("string");
        expect(cell.trim().length).toBeGreaterThan(0);
        // A real sentence, not a stub/placeholder token.
        expect(cell.trim().length).toBeGreaterThan(20);
      }
    }
  });

  it("no cell is a lazy copy-paste duplicate of another path's cell for the same axis", () => {
    for (const axis of COMPARISON_AXES) {
      const cells = ALL_PATHS.map((path) => PATH_COMPARISON[path][axis]);
      expect(new Set(cells).size).toBe(cells.length);
    }
  });

  // R9's plain-statement rule for Tunnel's third-party dependency — pinned
  // so a future edit cannot quietly soften it back into marketing copy.
  it("Tunnel's thirdParties cell names Cloudflare plainly (R4/R9)", () => {
    expect(PATH_COMPARISON.tunnel.thirdParties).toMatch(/Cloudflare/);
  });

  it("Remote's attackSurface cell states the silent-to-scanners fact (R1/R9)", () => {
    expect(PATH_COMPARISON.remote.attackSurface.toLowerCase()).toMatch(/silent|no response/);
  });
});

describe("comparisonRows — table-friendly derivation", () => {
  const rows = comparisonRows();

  it("returns exactly one row per axis, in COMPARISON_AXES order", () => {
    expect(rows.map((r) => r.axis)).toEqual([...COMPARISON_AXES]);
  });

  it("every row carries the axis's label and all three paths' values, matching PATH_COMPARISON exactly", () => {
    for (const row of rows) {
      expect(row.label).toBe(COMPARISON_AXIS_LABELS[row.axis as ComparisonAxis]);
      for (const path of ALL_PATHS) {
        expect(row.values[path]).toBe(PATH_COMPARISON[path][row.axis as ComparisonAxis]);
      }
    }
  });
});
