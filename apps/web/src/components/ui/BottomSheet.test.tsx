// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomSheet } from "./BottomSheet.js";
import { renderIntoBody, type TestRender } from "./test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** vi.advanceTimersByTime() fires the fallback setTimeout synchronously,
 *  but the resulting setState() call needs to be inside `act()` for React
 *  to flush it into the DOM before the next assertion runs. */
function advanceTimers(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function findByText(container: HTMLElement, text: string): HTMLElement | null {
  const all = container.querySelectorAll<HTMLElement>("button, span, h2, p, input");
  for (const el of all) {
    if (el.textContent === text) return el;
  }
  return null;
}

describe("BottomSheet", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
    document.body.style.overflow = "";
  });

  it("renders nothing while it has never been opened", () => {
    const onClose = vi.fn();
    view = renderIntoBody(
      <BottomSheet open={false} onClose={onClose} title="Never opened">
        <p>body</p>
      </BottomSheet>,
    );
    expect(view.container.innerHTML).toBe("");
  });

  it("renders the header row (title + sub + Done) and body once open", () => {
    const onClose = vi.fn();
    view = renderIntoBody(
      <BottomSheet open onClose={onClose} title="Add library" sub="Choose a folder">
        <p>Sheet body content</p>
      </BottomSheet>,
    );
    const dialog = view.container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(findByText(view.container, "Add library")).not.toBeNull();
    expect(findByText(view.container, "Choose a folder")).not.toBeNull();
    expect(findByText(view.container, "Done")).not.toBeNull();
    expect(view.container.textContent).toContain("Sheet body content");
  });

  it("supports a custom Done label", () => {
    const onClose = vi.fn();
    view = renderIntoBody(
      <BottomSheet open onClose={onClose} title="Confirm" doneLabel="Save">
        <p>body</p>
      </BottomSheet>,
    );
    expect(findByText(view.container, "Save")).not.toBeNull();
    expect(findByText(view.container, "Done")).toBeNull();
  });

  it("closes via the Done button", () => {
    const onClose = vi.fn();
    view = renderIntoBody(
      <BottomSheet open onClose={onClose} title="Sheet">
        <p>body</p>
      </BottomSheet>,
    );
    const done = findByText(view.container, "Done");
    done?.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on scrim click but not on a click inside the sheet", () => {
    const onClose = vi.fn();
    view = renderIntoBody(
      <BottomSheet open onClose={onClose} title="Sheet">
        <p>Sheet body</p>
      </BottomSheet>,
    );
    const dialog = view.container.querySelector('[role="dialog"]') as HTMLElement;
    dialog.click();
    expect(onClose).not.toHaveBeenCalled();

    const scrim = view.container.querySelector('[role="presentation"]') as HTMLElement;
    scrim.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    view = renderIntoBody(
      <BottomSheet open onClose={onClose} title="Sheet">
        <p>body</p>
      </BottomSheet>,
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose on Escape while closed", () => {
    const onClose = vi.fn();
    view = renderIntoBody(
      <BottomSheet open={false} onClose={onClose} title="Sheet">
        <p>body</p>
      </BottomSheet>,
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("traps focus: moves initial focus into the sheet and wraps Tab/Shift+Tab", () => {
    const onClose = vi.fn();
    view = renderIntoBody(
      <BottomSheet open onClose={onClose} title="Sheet">
        <button type="button">Action</button>
      </BottomSheet>,
    );
    const done = findByText(view.container, "Done") as HTMLButtonElement;
    const action = findByText(view.container, "Action") as HTMLButtonElement;

    // Initial focus lands on the first focusable element (Done, header
    // comes before body in DOM order).
    expect(document.activeElement).toBe(done);

    // Shift+Tab from the first focusable wraps to the last.
    const shiftTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(shiftTab);
    expect(document.activeElement).toBe(action);

    // Tab from the last focusable wraps back to the first.
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(document.activeElement).toBe(done);
  });

  it("returns focus to the previously-focused element after closing", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open sheet";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    vi.useFakeTimers();
    const onClose = vi.fn();
    view = renderIntoBody(
      <BottomSheet open onClose={onClose} title="Sheet">
        <p>body</p>
      </BottomSheet>,
    );
    expect(document.activeElement).not.toBe(trigger);

    view.rerender(
      <BottomSheet open={false} onClose={onClose} title="Sheet">
        <p>body</p>
      </BottomSheet>,
    );
    // Focus returns as soon as the trap deactivates (open -> false), well
    // before the exit-transition fallback timer fires.
    expect(document.activeElement).toBe(trigger);

    advanceTimers(500);
    trigger.remove();
  });

  it("locks body scroll while mounted and restores the prior value once the exit transition finishes", () => {
    document.body.style.overflow = "auto";
    vi.useFakeTimers();
    const onClose = vi.fn();
    view = renderIntoBody(
      <BottomSheet open onClose={onClose} title="Sheet">
        <p>body</p>
      </BottomSheet>,
    );
    expect(document.body.style.overflow).toBe("hidden");

    view.rerender(
      <BottomSheet open={false} onClose={onClose} title="Sheet">
        <p>body</p>
      </BottomSheet>,
    );
    // Still locked mid-exit (jsdom never fires a real transitionend; only
    // the fallback timer, matched to --motion-base, unmounts it).
    expect(document.body.style.overflow).toBe("hidden");

    advanceTimers(500);
    expect(document.body.style.overflow).toBe("auto");
    // And the sheet has actually left the DOM, not just gone invisible.
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("survives a dismiss requested mid-enter (before the RAF visibility flip) without throwing or getting stuck mounted", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    view = renderIntoBody(
      <BottomSheet open onClose={onClose} title="Sheet">
        <p>body</p>
      </BottomSheet>,
    );
    // Immediately request close, before any timer/RAF has had a chance to
    // flip `visible` true — this is the "dismiss mid-enter" case.
    expect(() => {
      view!.rerender(
        <BottomSheet open={false} onClose={onClose} title="Sheet">
          <p>body</p>
        </BottomSheet>,
      );
    }).not.toThrow();

    advanceTimers(500);
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps a stale onClose from firing twice: unmount after close never re-invokes onClose", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    view = renderIntoBody(
      <BottomSheet open onClose={onClose} title="Sheet">
        <p>body</p>
      </BottomSheet>,
    );
    view.rerender(
      <BottomSheet open={false} onClose={onClose} title="Sheet">
        <p>body</p>
      </BottomSheet>,
    );
    advanceTimers(500);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reduced-motion CSS: the sheet's translate is removed entirely (no travel), not merely shortened", () => {
    const css = readFileSync(path.join(__dirname, "BottomSheet.module.css"), "utf8");
    const reducedBlockMatch = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
    expect(reducedBlockMatch, "expected a prefers-reduced-motion block in BottomSheet.module.css").not.toBeNull();
    const block = reducedBlockMatch![1]!;
    expect(block).toContain(".sheet");
    expect(block).toContain("transform: none");
  });
});
