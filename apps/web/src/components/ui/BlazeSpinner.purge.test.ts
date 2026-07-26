// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/ui/BlazeSpinner.purge.test.ts
//
// Purge assertion: the old ring-spinner keyframes (loombre-spin from
// PlayerControls, spin from steps.module) no longer exist in their former
// homes after BlazeSpinner replaces them. This is Lane D's greps-allowlist
// scope — it runs against this file path explicitly.

import { readFileSync } from "fs";
import path from "path";
import { test, expect } from "vitest";

const playerControlsCss = readFileSync(
  path.join(__dirname, "../player/PlayerControls.module.css"),
  "utf-8"
);

const stepsCss = readFileSync(
  path.join(__dirname, "../../app/setup/_components/steps.module.css"),
  "utf-8"
);

test("PlayerControls.module.css: old loombre-spin keyframe removed (replaced by BlazeSpinner)", () => {
  // The old 48px ring spinner's keyframe must not exist anymore
  expect(playerControlsCss).not.toMatch(/@keyframes\s+loombre-spin/);
  // The animation reference in .spinner must also be gone
  expect(playerControlsCss).not.toMatch(/animation:[^}]*loombre-spin/);
});

test("steps.module.css: old spin keyframe removed (replaced by BlazeSpinner)", () => {
  // The old 16px ring spinners' keyframe must not exist anymore
  expect(stepsCss).not.toMatch(/@keyframes\s+spin\s*{/);
  // The animation reference in .spinner must also be gone
  expect(stepsCss).not.toMatch(/animation:[^}]*spin\s/);
});

test("PlayerControls.module.css: loombre-spin animation is completely removed", () => {
  // The old loombre-spin keyframe and animation reference must both be gone
  // (the .spinner class itself may or may not exist, depending on whether
  // other consumers need it, but the animation MUST be removed)
  expect(playerControlsCss).not.toMatch(/loombre-spin/);
});
