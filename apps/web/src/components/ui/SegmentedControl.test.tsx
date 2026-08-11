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
    return view!.container.querySelector('[role="radiogroup"]') as HTMLElement;
  }

  function segments(): HTMLButtonElement[] {
    return Array.from(track().querySelectorAll('button[role="radio"]'));
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

// Item 1 (an upstream media server-study Wave A): replaces the pre-existing role="tablist"/
// role="tab" with no keyboard support beyond plain Tab (STATE.md W2+W3's
// recorded deferral) with the WAI-ARIA APG "Radio Group" pattern — arrow
// keys move focus AND selection together, Home/End jump to the ends,
// exactly ONE segment is ever in the tab order.
describe("SegmentedControl — radiogroup pattern + roving tabindex (item 1)", () => {
  let view: TestRender | undefined;

  afterEach(() => {
    view?.unmount();
    view = undefined;
  });

  function track(): HTMLElement {
    return view!.container.querySelector('[role="radiogroup"]') as HTMLElement;
  }

  function segments(): HTMLButtonElement[] {
    return Array.from(track().querySelectorAll('button[role="radio"]'));
  }

  function pressKey(el: HTMLElement, key: string): void {
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }

  it("is a radiogroup of radios, never a tablist of tabs", () => {
    view = renderIntoBody(<SegmentedControl options={["Off", "On"]} defaultValue="Off" />);
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
    expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(track().getAttribute("role")).toBe("radiogroup");
    expect(segments()).toHaveLength(2);
  });

  it("aria-checked (not aria-selected) marks the active segment", () => {
    view = renderIntoBody(<SegmentedControl options={["Off", "On"]} defaultValue="On" />);
    const [off, on] = segments();
    expect(off!.getAttribute("aria-checked")).toBe("false");
    expect(on!.getAttribute("aria-checked")).toBe("true");
    expect(off!.hasAttribute("aria-selected")).toBe(false);
  });

  it("exactly ONE segment is in the tab order at a time — the checked one is 0, every other is -1", () => {
    view = renderIntoBody(<SegmentedControl options={["Info", "Warning", "Critical"]} defaultValue="Warning" />);
    const [info, warning, critical] = segments();
    expect(info!.tabIndex).toBe(-1);
    expect(warning!.tabIndex).toBe(0);
    expect(critical!.tabIndex).toBe(-1);
  });

  it("ArrowRight moves focus AND selection to the next segment, wrapping past the end", () => {
    view = renderIntoBody(<SegmentedControl options={["A", "B", "C"]} defaultValue="A" />);
    const [a, b, c] = segments();

    pressKey(a!, "ArrowRight");
    expect(b!.getAttribute("aria-checked")).toBe("true");
    expect(b!.tabIndex).toBe(0);
    expect(a!.tabIndex).toBe(-1);

    pressKey(b!, "ArrowRight");
    expect(c!.getAttribute("aria-checked")).toBe("true");

    // wraps from the last option back to the first
    pressKey(c!, "ArrowRight");
    expect(a!.getAttribute("aria-checked")).toBe("true");
    expect(a!.tabIndex).toBe(0);
  });

  it("ArrowLeft moves focus AND selection to the previous segment, wrapping before the start", () => {
    view = renderIntoBody(<SegmentedControl options={["A", "B", "C"]} defaultValue="A" />);
    const [a, , c] = segments();

    // wraps from the first option to the last
    pressKey(a!, "ArrowLeft");
    expect(c!.getAttribute("aria-checked")).toBe("true");
    expect(c!.tabIndex).toBe(0);
  });

  it("ArrowDown/ArrowUp behave identically to ArrowRight/ArrowLeft", () => {
    view = renderIntoBody(<SegmentedControl options={["A", "B", "C"]} defaultValue="A" />);
    const [a, b] = segments();

    pressKey(a!, "ArrowDown");
    expect(b!.getAttribute("aria-checked")).toBe("true");

    pressKey(b!, "ArrowUp");
    expect(a!.getAttribute("aria-checked")).toBe("true");
  });

  it("Home jumps to the first option, End jumps to the last — both select, not just focus", () => {
    view = renderIntoBody(<SegmentedControl options={["A", "B", "C", "D"]} defaultValue="B" />);
    const [a, b, , d] = segments();

    pressKey(b!, "End");
    expect(d!.getAttribute("aria-checked")).toBe("true");
    expect(d!.tabIndex).toBe(0);

    pressKey(d!, "Home");
    expect(a!.getAttribute("aria-checked")).toBe("true");
    expect(a!.tabIndex).toBe(0);
  });

  it("onChange fires on every keyboard-driven move, same as a click", () => {
    const received: string[] = [];
    view = renderIntoBody(<SegmentedControl options={["A", "B", "C"]} defaultValue="A" onChange={(v) => received.push(v)} />);
    const [a] = segments();

    pressKey(a!, "ArrowRight");
    expect(received).toEqual(["B"]);
  });

  it("supports {value,label} option pairs, not just plain strings (LibraryPills/SortControl/ZoneSortControl/SeasonPillTabs shape)", () => {
    view = renderIntoBody(
      <SegmentedControl
        options={[
          { value: "id-1", label: "Movies" },
          { value: "id-2", label: "TV Shows" },
        ]}
        defaultValue="id-1"
      />,
    );
    const [first] = segments();
    expect(first!.textContent).toBe("Movies");
    expect(first!.getAttribute("aria-checked")).toBe("true");
  });

  it("controlled mode: an explicit `value` prop wins over internal state, and onChange is the only way selection moves", async () => {
    let controlledValue = "A";
    const handleChange = (v: string): void => {
      controlledValue = v;
    };
    view = renderIntoBody(<SegmentedControl options={["A", "B"]} value={controlledValue} onChange={handleChange} />);
    const [a, b] = segments();

    await act(async () => {
      b!.click();
    });
    // onChange fired (controlledValue mutated)...
    expect(controlledValue).toBe("B");
    // ...but since the component was never re-rendered with the new
    // `value` prop, its OWN displayed state does not silently drift —
    // proving `value` (not internal state) is authoritative in controlled
    // mode, exactly like a real <input type="radio" checked> would behave.
    expect(a!.getAttribute("aria-checked")).toBe("true");
    expect(b!.getAttribute("aria-checked")).toBe("false");

    // Re-rendering with the caller's own updated value is what actually
    // moves the checked segment.
    view.rerender(<SegmentedControl options={["A", "B"]} value="B" onChange={handleChange} />);
    expect(track().querySelector('[aria-checked="true"]')?.textContent).toBe("B");
  });
});
