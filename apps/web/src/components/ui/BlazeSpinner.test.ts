// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/ui/BlazeSpinner.test.ts
//
// CSS-source tests pinning D9 exact animation numbers for the Blaze spinner
// (blaze .85s/.6s durations, origins 50% 84% / 50% 68%, transform-only).

import { readFileSync } from "fs";
import path from "path";
import { test, expect } from "vitest";

const blazeSpinnerCss = readFileSync(
  path.join(__dirname, "BlazeSpinner.module.css"),
  "utf-8"
);

test("BlazeSpinner.module.css: blaze animation is exactly .85s at origin 50% 84%", () => {
  // D9: the outer flame wobble, ~80% of the splash's 1.05s reference
  expect(blazeSpinnerCss).toMatch(
    /\.blaze\s*{\s*[^}]*animation:[^}]*\.85s/
  );
  expect(blazeSpinnerCss).toMatch(
    /\.blaze\s*{\s*[^}]*transform-origin:[^}]*50%\s+84%/
  );
});

test("BlazeSpinner.module.css: flicker animation is exactly .6s at origin 50% 68%", () => {
  // D9: the core idle flicker, ~80% of the splash's .72s reference
  expect(blazeSpinnerCss).toMatch(
    /\.core\s*{\s*[^}]*animation:[^}]*\.6s/
  );
  expect(blazeSpinnerCss).toMatch(
    /\.core\s*{\s*[^}]*transform-origin:[^}]*50%\s+68%/
  );
});

test("BlazeSpinner.module.css: reduced-motion renders settled pose with animation: none", () => {
  // D10: infinite animations collapse to settled pose under prefers-reduced-motion
  expect(blazeSpinnerCss).toMatch(
    /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/
  );
  expect(blazeSpinnerCss).toMatch(
    /prefers-reduced-motion[^}]*animation:\s*none/
  );
});

test("BlazeSpinner.module.css: keyframes are transform-only (no filters, no opacity changes)", () => {
  // D9 + P2.10: transform-only animations (layout/paint never fire)
  // Just check that the keyframes exist and don't contain forbidden properties
  expect(blazeSpinnerCss).toContain("@keyframes blaze");
  expect(blazeSpinnerCss).toContain("@keyframes flicker");
  // Verify no filter or opacity in the keyframes
  const blazeKeyframeRegex = /@keyframes\s+blaze[\s\S]*?}/;
  const blazeKeyframe = blazeSpinnerCss.match(blazeKeyframeRegex);
  if (blazeKeyframe) {
    expect(blazeKeyframe[0]).not.toMatch(/filter:/);
    expect(blazeKeyframe[0]).not.toMatch(/opacity:/);
  }

  const flickerKeyframeRegex = /@keyframes\s+flicker[\s\S]*?}/;
  const flickerKeyframe = blazeSpinnerCss.match(flickerKeyframeRegex);
  if (flickerKeyframe) {
    expect(flickerKeyframe[0]).not.toMatch(/filter:/);
    expect(flickerKeyframe[0]).not.toMatch(/opacity:/);
  }
});
