// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/ui/SegmentedControl.test.tsx
//
// D-2 (STATE.md W2+W3, owner screenshots — Log tail/Notices/Add-library
// Kind/library General-Restricted toggle): the selected amber pill
// ballooned past its label (excessive horizontal padding) and the outer
// track stretched to fill its container instead of hugging its segments.
// jsdom never evaluates imported CSS (component .module.css imports are
// stubbed to an identity proxy — see phosphor-mobile-css.test.ts's own
// header for the established precedent), so the padding/width assertions
// below read the compiled CSS text directly rather than computed styles;
// the DOM-structure assertions (data-active / data-full-width wiring)
// render the real component.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { renderIntoBody, type TestRender } from "./test-render.js";
import { SegmentedControl } from "./SegmentedControl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(__dirname, "SegmentedControl.module.css"), "utf8");

function ruleFor(selector: string): string {
  const re = new RegExp(`${selector.replace(/[.[\]="]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const match = re.exec(css);
  expect(match, `expected a ${selector} rule in SegmentedControl.module.css`).not.toBeNull();
  return match![1]!;
}

describe("SegmentedControl.module.css — selected-pill sizing (D-2)", () => {
  it(".segment uses exactly ONE horizontal inset token, applied to every segment (not just the selected one)", () => {
    const rule = ruleFor(".segment");
    const paddingMatch = /padding:\s*([^;]+);/.exec(rule);
    expect(paddingMatch, "expected a padding declaration on .segment").not.toBeNull();
    const [vertical, horizontal] = paddingMatch![1]!.trim().split(/\s+/);
    expect(horizontal).toBeDefined();
    expect(vertical).toBeDefined();
    // The regression: --space-md (16px) read as "far too wide" against a
    // single short label. Assert the tightened, compact token instead of
    // merely asserting "not --space-md", so a future regression back to a
    // generous token also fails this test.
    expect(horizontal).toBe("var(--space-sm)");
    // No separate, wider padding declared for the active/selected state —
    // the fill color must not be hiding extra inset the unselected pills
    // don't have.
    expect(css).not.toMatch(/\.segment\[data-active="true"\]\s*\{[^}]*padding/);
  });

  it(".track hugs its segments by default (fit-content, never a stretched 100%)", () => {
    const rule = ruleFor(".track");
    expect(rule).toMatch(/width:\s*fit-content;/);
    expect(rule).not.toMatch(/width:\s*100%/);
  });

  it("the only way to a full-width track is the explicit opt-in attribute", () => {
    const rule = ruleFor('.track[data-full-width="true"]');
    expect(rule).toMatch(/width:\s*100%;/);
  });
});

describe("SegmentedControl — DOM structure", () => {
  let view: TestRender | undefined;

  afterEach(() => {
    view?.unmount();
    view = undefined;
  });

  function track(): HTMLElement {
    return view!.container.querySelector('[role="tablist"]') as HTMLElement;
  }

  function segments(): HTMLButtonElement[] {
    return Array.from(track().querySelectorAll('button[role="tab"]'));
  }

  it("does not set data-full-width when the caller never opts in", () => {
    view = renderIntoBody(<SegmentedControl options={["Info", "Warning", "Critical"]} />);
    expect(track().hasAttribute("data-full-width")).toBe(false);
  });

  it("sets data-full-width=\"true\" only when a caller explicitly opts in", () => {
    view = renderIntoBody(<SegmentedControl options={["Info", "Warning", "Critical"]} fullWidth />);
    expect(track().getAttribute("data-full-width")).toBe("true");
  });

  it("exactly one segment is data-active at a time, and it moves on click", async () => {
    view = renderIntoBody(<SegmentedControl options={["Off", "On"]} defaultValue="Off" />);
    const [off, on] = segments();
    expect(off!.getAttribute("data-active")).toBe("true");
    expect(on!.getAttribute("data-active")).toBe("false");

    await act(async () => {
      on!.click();
    });

    expect(off!.getAttribute("data-active")).toBe("false");
    expect(on!.getAttribute("data-active")).toBe("true");
  });

  it("onChange receives the raw option string (callers own any label→value mapping — D-3)", async () => {
    let received: string | null = null;
    view = renderIntoBody(
      <SegmentedControl options={["Movie", "TV", "Music"]} defaultValue="Movie" onChange={(v) => (received = v)} />,
    );
    const [, tv] = segments();

    await act(async () => {
      tv!.click();
    });

    expect(received).toBe("TV");
  });
});
