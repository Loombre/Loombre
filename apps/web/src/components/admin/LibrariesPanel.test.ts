// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/admin/LibrariesPanel.test.ts
//
// CSS-source tests pinning D9 exact animation numbers for the Blaze
// indeterminate bar (3px track, 34% amber segment, -110% → 360%, 1.6s).

import { readFileSync } from "fs";
import path from "path";
import { test, expect } from "vitest";

const librariesPanelCss = readFileSync(
  path.join(__dirname, "LibrariesPanel.module.css"),
  "utf-8"
);

test("LibrariesPanel.module.css: scanBar track is 3px at white 8% (D9's rgba(255,255,255,.08))", () => {
  // D9: the indeterminate bar's track specs. The CSS carries the
  // stylelint-enforced modern notation rgb(255 255 255 / 8%) — the same
  // computed color as D9's legacy rgba(255,255,255,.08) (same adjudication
  // as Lane B's notation deviation, recorded at the W1 freeze).
  expect(librariesPanelCss).toMatch(/\.scanBar[\s\S]*?height:\s*3px/);
  expect(librariesPanelCss).toMatch(
    /rgb\(\s*255\s+255\s+255\s*\/\s*8%\s*\)/
  );
});

test("LibrariesPanel.module.css: segment is ~34% width sliding -110% to 360% in 1.6s", () => {
  // D9: the animated amber segment dimensions and translate keyframe
  const segmentBlock = librariesPanelCss.match(
    /\.scanBar::after\s*{[^}]*width:[^}]*}/
  );
  expect(segmentBlock).toBeTruthy();
  if (segmentBlock) {
    // ~34% width
    expect(segmentBlock[0]).toMatch(/width:[^}]*3[34]%/);
  }

  // Animation must be exactly 1.6s ease-in-out
  expect(librariesPanelCss).toMatch(
    /\.scanBar::after\s*{[^}]*animation:[^}]*1\.6s\s+ease-in-out/
  );
});

test("LibrariesPanel.module.css: indeterminate keyframe moves -110% to 360%", () => {
  // D9: exact translate percentages
  expect(librariesPanelCss).toContain("translateX(-110%)");
  expect(librariesPanelCss).toContain("translateX(360%)");
  expect(librariesPanelCss).toContain("@keyframes blaze-indeterminate");
});

test("LibrariesPanel.module.css: segment uses var(--brand-amber), not var(--color-accent)", () => {
  // D9 + G4: brand-fixed amber, never the user-swappable accent
  expect(librariesPanelCss).toMatch(
    /\.scanBar::after\s*{[^}]*background:[^}]*--brand-amber/
  );
  // Verify --color-accent is NOT used in the segment
  const segmentBlock = librariesPanelCss.match(
    /\.scanBar::after\s*{[^}]*background:[^}]*/
  );
  if (segmentBlock) {
    expect(segmentBlock[0]).not.toMatch(/--color-accent/);
  }
});

test("LibrariesPanel.module.css: reduced-motion settled pose with animation: none and translateX(30%)", () => {
  // D10: infinite animation collapses to settled pose
  expect(librariesPanelCss).toMatch(
    /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/
  );
  expect(librariesPanelCss).toMatch(
    /prefers-reduced-motion[^}]*\.scanBar::after[^}]*animation:\s*none/
  );
  expect(librariesPanelCss).toMatch(
    /prefers-reduced-motion[^}]*\.scanBar::after[^}]*transform:\s*translateX\(\s*30%\s*\)/
  );
});
