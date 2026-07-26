// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/brand/blaze-provenance.test.ts
//
// STATE.md "Blaze logo rollout" D1 ("byte-faithful ... path data, gradient
// stops, scanline pattern untouched") + D3 ("path data lives in EXACTLY ONE
// module — no copy-pasted path strings anywhere else in the tree"). This
// test makes "one geometry, one module" mechanical: it reads the design
// masters' raw SVG text directly (no new XML-parser dependency — same
// regex-over-source-text convention as
// components/admin/settings/phosphor-mobile-css.test.ts /
// components/ui/Toast.test.tsx's reduced-motion-CSS test) and asserts every
// geometric constant blaze-paths.ts exports is byte-identical to what the
// masters actually contain. A hand-edit to either side that drifts from the
// other fails here, not just in an eyeball review.
//
// Written and run RED (the masters existed; blaze-paths.ts did not) before
// blaze-paths.ts was authored — STATE.md "Feedback-loop-first".

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BLAZE_COMBINED_D,
  BLAZE_CORE_D,
  BLAZE_GRADIENT_STOPS,
  BLAZE_GRADIENT_X1,
  BLAZE_GRADIENT_X2,
  BLAZE_GRADIENT_Y1,
  BLAZE_GRADIENT_Y2,
  BLAZE_OUTER_D,
  BLAZE_SCANLINE_OVERLAY_RECT,
  BLAZE_SCANLINE_PATTERN,
} from "./blaze-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/web/src/components/brand -> repo root is 5 levels up.
const REPO_ROOT = path.join(__dirname, "../../../../..");
const SVG_DIR = path.join(REPO_ROOT, "design/blaze/assets/svg");

function readMaster(name: string): string {
  return readFileSync(path.join(SVG_DIR, name), "utf8");
}

/** Every `d="..."` attribute value appearing in the source, in document order. */
function allPathD(source: string): string[] {
  return Array.from(source.matchAll(/\sd="([^"]+)"/g)).map((m) => m[1]!);
}

/** Splits a combined "outer core" `d` string at its one subpath boundary
 *  ("...Z M...") — both master subpaths start with M and end with Z, and
 *  that boundary is the only "Z M" substring in the value. */
function splitCombined(d: string): { outer: string; core: string } {
  const parts = d.split(/(?<=Z) (?=M)/);
  expect(parts.length, `expected exactly 2 subpaths in "${d}"`).toBe(2);
  return { outer: parts[0]!, core: parts[1]! };
}

describe("blaze-paths.ts provenance — loombre-mark.svg (gradient master)", () => {
  const svg = readMaster("loombre-mark.svg");

  it("outer/core path data matches the master byte-for-byte", () => {
    const ds = allPathD(svg);
    expect(ds.length).toBe(1);
    const { outer, core } = splitCombined(ds[0]!);
    expect(outer).toBe(BLAZE_OUTER_D);
    expect(core).toBe(BLAZE_CORE_D);
    expect(ds[0]).toBe(BLAZE_COMBINED_D);
  });

  it("gradient direction + stops match the master (bottom→top, amber-bright/amber/amber-deep)", () => {
    const gradientAttrs = /<linearGradient id="g" x1="([^"]*)" y1="([^"]*)" x2="([^"]*)" y2="([^"]*)"/.exec(svg);
    expect(gradientAttrs).not.toBeNull();
    expect(gradientAttrs![1]).toBe(BLAZE_GRADIENT_X1);
    expect(gradientAttrs![2]).toBe(BLAZE_GRADIENT_Y1);
    expect(gradientAttrs![3]).toBe(BLAZE_GRADIENT_X2);
    expect(gradientAttrs![4]).toBe(BLAZE_GRADIENT_Y2);

    const stops = Array.from(svg.matchAll(/<stop offset="([^"]+)" stop-color="(#[0-9A-Fa-f]{6})"/g)).map((m) => ({
      offset: m[1]!,
      color: m[2]!,
    }));
    expect(stops).toEqual(BLAZE_GRADIENT_STOPS);
  });
});

describe("blaze-paths.ts provenance — loombre-mark-flat.svg (flat master)", () => {
  it("flat path data + fill match the master byte-for-byte", () => {
    const svg = readMaster("loombre-mark-flat.svg");
    const ds = allPathD(svg);
    expect(ds.length).toBe(1);
    expect(ds[0]).toBe(BLAZE_COMBINED_D);
    expect(/fill="(#[0-9A-Fa-f]{6})"/.exec(svg)?.[1]).toBe("#FFB454");
  });
});

describe("blaze-paths.ts provenance — loombre-mark-scanline.svg (scanline master)", () => {
  const svg = readMaster("loombre-mark-scanline.svg");

  it("every path d in the file (flame + clip geometry) matches the combined constant", () => {
    const ds = allPathD(svg);
    // The visible flame path AND the <clipPath>'s geometry path both carry
    // the identical d string in the master — at least 2 occurrences.
    expect(ds.length).toBeGreaterThanOrEqual(2);
    for (const d of ds) {
      expect(d).toBe(BLAZE_COMBINED_D);
    }
  });

  it("scanline pattern geometry matches the master byte-for-byte", () => {
    const patternMatch = /<pattern id="p" patternUnits="userSpaceOnUse" width="([\d.]+)" height="([\d.]+)">/.exec(
      svg,
    );
    expect(patternMatch).not.toBeNull();
    expect(Number(patternMatch![1])).toBe(BLAZE_SCANLINE_PATTERN.width);
    expect(Number(patternMatch![2])).toBe(BLAZE_SCANLINE_PATTERN.height);

    const rectMatch = /<rect width="([\d.]+)" height="([\d.]+)" fill="(#[0-9A-Fa-f]{6})" opacity="([\d.]+)">/.exec(
      svg,
    );
    expect(rectMatch).not.toBeNull();
    expect(Number(rectMatch![1])).toBe(BLAZE_SCANLINE_PATTERN.width);
    expect(Number(rectMatch![2])).toBe(BLAZE_SCANLINE_PATTERN.lineHeight);
    expect(rectMatch![3]).toBe(BLAZE_SCANLINE_PATTERN.color);
    expect(Number(rectMatch![4])).toBe(BLAZE_SCANLINE_PATTERN.opacity);
  });

  it("scanline overlay rect geometry matches the master byte-for-byte", () => {
    const overlayMatch = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="url\(#p\)">/.exec(
      svg,
    );
    expect(overlayMatch).not.toBeNull();
    expect(Number(overlayMatch![1])).toBe(BLAZE_SCANLINE_OVERLAY_RECT.x);
    expect(Number(overlayMatch![2])).toBe(BLAZE_SCANLINE_OVERLAY_RECT.y);
    expect(Number(overlayMatch![3])).toBe(BLAZE_SCANLINE_OVERLAY_RECT.width);
    expect(Number(overlayMatch![4])).toBe(BLAZE_SCANLINE_OVERLAY_RECT.height);
  });
});
