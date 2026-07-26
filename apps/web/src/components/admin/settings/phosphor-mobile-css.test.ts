// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/settings/phosphor-mobile-css.test.ts
//
// Narrow-viewport (392px, README's phone frame) rendering evidence for the
// registry + provider-key panes (STATE.md Phosphor Wave-2 lane L6, scope
// items 2/3: "verify the shapes render correctly at 392 width" / "cards
// reflow; keyboard-friendly; 44px targets"). vitest runs in jsdom, which
// does not evaluate @media conditions for layout — so, same as
// components/ui/Toast.test.tsx's own "reduced-motion CSS" test, this reads
// each module's compiled CSS text directly and asserts the 767.98px
// breakpoint block (the literal this whole codebase repeats instead of a
// var() — see AppShell.module.css's own note for why) carries the
// narrow-specific rules this lane's freeze report claims. DOM-level
// behavior that does NOT depend on CSS evaluation (padlock icon presence,
// locked caption text, absence of an editor) is covered instead in
// SettingField.test.tsx's "env-locked rendering" describe block.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function mobileBlock(cssFileName: string): string {
  const css = readFileSync(path.join(__dirname, cssFileName), "utf8");
  const match = /@media \(width <= 767\.98px\) \{([\s\S]*)\}\s*$/.exec(css);
  expect(match, `expected a 767.98px @media block in ${cssFileName}`).not.toBeNull();
  return match![1]!;
}

describe("SettingField.module.css — mobile (<=767.98px)", () => {
  const block = mobileBlock("SettingField.module.css");

  it("boxes each field individually (border + radius + fill), matching the prototype's per-key mobile card", () => {
    expect(block).toMatch(/\.field\s*\{[^}]*border:\s*1px solid var\(--color-border-subtle\)/);
    expect(block).toMatch(/\.field\s*\{[^}]*border-radius:\s*var\(--radius-md\)/);
    expect(block).toMatch(/\.field\s*\{[^}]*background:\s*var\(--fill-1\)/);
  });

  it("hides the CURRENT fact (the widget itself already shows the current value on a single-column layout)", () => {
    expect(block).toMatch(/\.factValueCurrent,\s*\n?\s*\.factCurrent\s*\{\s*display:\s*none;/);
  });

  it("grows every interactive control to the 44px touch floor (stepper buttons, string input, bool row)", () => {
    expect(block).toMatch(/\.stepButton\s*\{[^}]*width:\s*44px;\s*height:\s*44px;/);
    expect(block).toMatch(/input\.stringInput\s*\{[^}]*min-height:\s*44px;/);
    expect(block).toMatch(/\.boolRow\s*\{[^}]*min-height:\s*44px;/);
  });
});

describe("SettingsCategoryCard.module.css — mobile (<=767.98px)", () => {
  const block = mobileBlock("SettingsCategoryCard.module.css");

  it("strips the shared category box back to just its header (each field boxes itself instead)", () => {
    expect(block).toMatch(/\.card\s*\{[^}]*border:\s*none;/);
    expect(block).toMatch(/\.card\s*\{[^}]*padding:\s*0;/);
  });

  it("removes the desktop inter-field hairline (each mobile card carries its own full border instead)", () => {
    expect(block).toMatch(/\.list > \* \+ \*\s*\{\s*border-top:\s*none;/);
  });
});

describe("ProviderKeysCard.module.css — mobile (<=767.98px)", () => {
  const block = mobileBlock("ProviderKeysCard.module.css");

  it("stacks the password-replace row and grows Save/Cancel to full-width 44px targets", () => {
    expect(block).toMatch(/\.replaceRow\s*\{[^}]*flex-direction:\s*column;/);
    expect(block).toMatch(/min-height:\s*44px;/);
  });

  it("stacks the danger-tinted confirm block for a narrow viewport", () => {
    expect(block).toMatch(/\.confirmBlock\s*\{[^}]*flex-direction:\s*column;/);
  });
});

describe("RegistryFilterBar.module.css — mobile (<=767.98px)", () => {
  const block = mobileBlock("RegistryFilterBar.module.css");

  it("the filter field becomes a boxed (radius-md) full-width control, not the desktop pill", () => {
    expect(block).toMatch(/\.searchInput\s*\{[^}]*border-radius:\s*var\(--radius-md\)/);
    expect(block).toMatch(/\.searchInput\s*\{[^}]*min-height:\s*44px;/);
  });

  it("the category pill row becomes a single horizontally-scrolling strip with 44px pills", () => {
    expect(block).toMatch(/\.pillRow\s*\{[^}]*overflow-x:\s*auto;/);
    expect(block).toMatch(/\.pill\s*\{[^}]*min-height:\s*44px;/);
  });
});
