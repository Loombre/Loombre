// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/brand/BootSplash.test.tsx
//
// STATE.md "Blaze logo rollout" — feedback-loop-first: written RED before
// BootSplash.tsx/.module.css existed. Covers everything EXCEPT the banned-
// fixture literal checks (those live only in BootSplash.fixtures.test.tsx,
// per Lane D's fixture-hygiene grep path allowlist):
//
//   - D3: animated two-path BlazeMark, core filled with the splash's own
//     surface token (--color-bg-splash, not the app-wide --color-bg).
//   - D9: the module-level `booted` one-shot — plays on first mount, a
//     second mount in the same tab session renders nothing.
//   - D10/G6: reduced-motion CSS collapse (readFileSync + regex — the
//     Toast.test.tsx:186 / phosphor-mobile-css.test.ts precedent; jsdom
//     never evaluates @media itself).
//   - D4 (G3 scope pin): the bloom's filter keyframe exists ONLY in this
//     component's own CSS module — nowhere else under components/brand —
//     and the infinite idle keyframes (blaze/flicker) animate transform
//     ONLY, never filter/opacity (the "fix" D4 explicitly forbids).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BootSplash, __resetBootSplashForTests } from "./BootSplash.js";
import { renderIntoBody } from "../ui/test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS_PATH = path.join(__dirname, "BootSplash.module.css");
const css = readFileSync(CSS_PATH, "utf8");

function markParts(container: HTMLElement): HTMLElement[] {
  const svg = container.querySelector("svg")!;
  return Array.from(svg.querySelectorAll("[data-mark-part]"));
}

describe("BootSplash — mark render mode (D3)", () => {
  it("mounts BlazeMark animated (two paths), core filled with the splash surface token", () => {
    __resetBootSplashForTests();
    const view = renderIntoBody(<BootSplash />);
    const parts = markParts(view.container);
    expect(parts.length).toBe(2);
    const core = parts.find((p) => p.getAttribute("data-mark-part") === "core")!;
    expect(core.getAttribute("fill")).toBe("var(--color-bg-splash)");
    view.unmount();
  });
});

describe("BootSplash — one-shot booted gate (D9)", () => {
  it("plays on the first mount, renders nothing on a second mount in the same tab session", () => {
    __resetBootSplashForTests();
    const first = renderIntoBody(<BootSplash />);
    expect(first.container.querySelector("svg")).not.toBeNull();
    first.unmount();

    const second = renderIntoBody(<BootSplash />);
    expect(second.container.textContent).toBe("");
    expect(second.container.querySelector("svg")).toBeNull();
    second.unmount();
  });
});

describe("BootSplash.module.css — reduced motion (D10/G6)", () => {
  it("collapses the one-shots to .01s duration / 0s delay with class-level !important (beats globals.css's 100ms * clamp)", () => {
    const idx = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(idx, "expected a prefers-reduced-motion block in BootSplash.module.css").toBeGreaterThan(-1);
    const block = css.slice(idx);
    expect(block).toMatch(/animation-duration:\s*0?\.01s\s*!important/);
    expect(block).toMatch(/animation-delay:\s*0s\s*!important/);
    expect(block).toContain(".rig");
    expect(block).toContain(".mark");
    expect(block).toContain(".word");
    expect(block).toContain(".bootLine");
  });

  it("settles the infinite idles (blaze/flicker) via animation: none, not a mere duration collapse", () => {
    const idx = css.indexOf("@media (prefers-reduced-motion: reduce)");
    const block = css.slice(idx);
    expect(block).toMatch(/\.blaze,\s*\n\s*\.core\s*\{[^}]*animation:\s*none\s*!important/);
  });
});

describe("BootSplash.module.css — D4 bloom scope pin", () => {
  it("defines the filter-animating bloom keyframe here, and nowhere else under components/brand", () => {
    expect(css).toMatch(/@keyframes loombre-boot-splash-flash\s*\{/);
    expect(css).toMatch(/filter:\s*brightness\(1\)/);

    const brandDir = __dirname;
    const siblingCssFiles = readdirSync(brandDir).filter((f) => f.endsWith(".css") && f !== "BootSplash.module.css");
    for (const file of siblingCssFiles) {
      const siblingCss = readFileSync(path.join(brandDir, file), "utf8");
      expect(siblingCss, `${file} must not animate filter — D4's exception is scoped to BootSplash's bloom only`).not.toMatch(
        /filter\s*:/,
      );
    }
  });

  it("the infinite idle keyframes (blaze/flicker) animate transform ONLY — no filter/opacity 'fix'", () => {
    for (const name of ["loombre-boot-splash-blaze", "loombre-boot-splash-flicker"]) {
      const re = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}\\n`, "m");
      const body = re.exec(css)?.[1];
      expect(body, `expected to find @keyframes ${name} in BootSplash.module.css`).toBeTruthy();
      expect(body).toMatch(/transform:/);
      expect(body).not.toMatch(/filter\s*:/);
      expect(body).not.toMatch(/opacity\s*:/);
      expect(body).not.toMatch(/box-shadow\s*:/);
      expect(body).not.toMatch(/drop-shadow/);
    }
  });
});
