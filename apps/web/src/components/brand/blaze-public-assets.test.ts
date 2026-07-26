// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/brand/blaze-public-assets.test.ts
//
// STATE.md "Blaze logo rollout" D1: "SVG files ARE the production assets
// ... ship into apps/web public assets byte-faithful (path data, gradient
// stops, scanline pattern untouched)". Buffer equality, not text/whitespace
// comparison — a re-serialized-but-visually-identical copy must still fail
// this test, matching D1's own anchor (a SHA-256 over the exact master
// bytes, recorded in STATE.md "D1 byte-faithful anchor").
//
// Written and run RED (the design masters existed; nothing had been copied
// into apps/web/public/ yet) before the copies were made.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/web/src/components/brand -> repo root is 5 levels up.
const REPO_ROOT = path.join(__dirname, "../../../../..");

const SHIPPED_COPIES: ReadonlyArray<{ master: string; shipped: string }> = [
  { master: "design/blaze/assets/svg/loombre-mark.svg", shipped: "apps/web/public/brand/loombre-mark.svg" },
  {
    master: "design/blaze/assets/svg/loombre-mark-scanline.svg",
    shipped: "apps/web/public/brand/loombre-mark-scanline.svg",
  },
  {
    master: "design/blaze/assets/svg/loombre-mark-flat.svg",
    shipped: "apps/web/public/brand/loombre-mark-flat.svg",
  },
  { master: "design/blaze/assets/svg/loombre-favicon.svg", shipped: "apps/web/public/loombre-favicon.svg" },
];

describe("shipped public/ brand SVGs are byte-identical to the design masters (D1)", () => {
  for (const { master, shipped } of SHIPPED_COPIES) {
    it(`${shipped} === ${master}`, () => {
      const masterBuf = readFileSync(path.join(REPO_ROOT, master));
      const shippedBuf = readFileSync(path.join(REPO_ROOT, shipped));
      expect(shippedBuf.equals(masterBuf)).toBe(true);
    });
  }
});
