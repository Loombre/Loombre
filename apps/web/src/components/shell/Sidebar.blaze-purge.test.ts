// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/shell/Sidebar.blaze-purge.test.ts
//
// Lane A (Blaze logo rollout Wave 1): hygiene assertions for the sidebar
// horizontal lockup replacement (D8, G10). Verifies that the pulse-dot era
// artifacts are purged: the .wordmarkDot class definition, the
// sidebar-wordmark-pulse keyframe, and the tablet collapse block no longer
// hides the mark-only lockup.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Sidebar.module.css — Blaze D8/G10 purge (pulse-dot era removal)", () => {
  const css = readFileSync(path.join(__dirname, "Sidebar.module.css"), "utf8");

  it("removes the .wordmarkDot class definition entirely", () => {
    expect(css, ".wordmarkDot class must be deleted per D8").not.toMatch(/\.wordmarkDot\s*\{/);
  });

  it("removes the sidebar-wordmark-pulse keyframe definition entirely", () => {
    expect(css, "sidebar-wordmark-pulse keyframe must be deleted per D8").not.toMatch(/@keyframes\s+sidebar-wordmark-pulse/);
  });

  it("marks G10 tablet collapse (<=1279.98px): .wordmarkRow is NOT in display:none group, so mark-only stays visible", () => {
    const tabletBlockMatch = /@media \(width <= 1279\.98px\) \{([\s\S]*?)\n\}/.exec(css);
    expect(tabletBlockMatch, "expected a 1279.98px @media block in Sidebar.module.css").not.toBeNull();
    const tabletBlock = tabletBlockMatch![1]!;

    // The block should NOT hide .wordmarkRow in a display:none rule alongside
    // other labels/counts. Per G10, the mark stays visible, so .wordmarkRow
    // must be missing from the selector list.
    expect(tabletBlock).not.toMatch(/\.wordmarkRow\s*,[\s\S]*?display:\s*none;/);
  });
});
