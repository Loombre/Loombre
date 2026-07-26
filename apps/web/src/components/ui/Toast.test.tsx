// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./Toast.js";
import { renderIntoBody, type TestRender } from "./test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function advanceTimers(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

let latestToastApi: ReturnType<typeof useToast> | null = null;

function Probe(): null {
  latestToastApi = useToast();
  return null;
}

function renderProvider(): TestRender {
  latestToastApi = null;
  return renderIntoBody(
    <ToastProvider>
      <Probe />
    </ToastProvider>,
  );
}

function getViewport(container: HTMLElement): HTMLElement {
  return container.querySelector('[aria-live="polite"]')!.parentElement as HTMLElement;
}

function getLiveRegion(container: HTMLElement): HTMLElement {
  return container.querySelector('[aria-live="polite"]') as HTMLElement;
}

describe("ToastProvider / useToast", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  it("throws when useToast() is called outside a ToastProvider", () => {
    function Bare(): null {
      useToast();
      return null;
    }
    // Suppress React's noisy error-boundary console output for this
    // expected-throw case.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderIntoBody(<Bare />)).toThrow(/useToast\(\) called outside/);
    spy.mockRestore();
  });

  it("renders an always-present aria-live region, empty and hidden before any toast", () => {
    view = renderProvider();
    const live = getLiveRegion(view.container);
    expect(live).not.toBeNull();
    expect(live.getAttribute("aria-atomic")).toBe("true");
    const viewport = getViewport(view.container);
    expect(viewport.getAttribute("data-visible")).toBe("false");
    expect(live.textContent).toBe("");
  });

  it("shows a toast with the message text and an accent dot by default", () => {
    view = renderProvider();
    act(() => {
      latestToastApi!.showToast("SAVED");
    });
    const viewport = getViewport(view.container);
    expect(viewport.getAttribute("data-visible")).toBe("true");
    expect(getLiveRegion(view.container).textContent).toBe("SAVED");
    const dot = view.container.querySelector("[data-variant]");
    expect(dot?.getAttribute("data-variant")).toBe("accent");
  });

  it("supports a warning variant for the dot", () => {
    view = renderProvider();
    act(() => {
      latestToastApi!.showToast("RESTRICTED ITEMS HIDDEN", { variant: "warning" });
    });
    const dot = view.container.querySelector("[data-variant]");
    expect(dot?.getAttribute("data-variant")).toBe("warning");
  });

  it("auto-dismisses after 2.6s by default", () => {
    vi.useFakeTimers();
    view = renderProvider();
    act(() => {
      latestToastApi!.showToast("ADDED TO WATCHLIST");
    });
    expect(getViewport(view.container).getAttribute("data-visible")).toBe("true");

    advanceTimers(2599);
    expect(getViewport(view.container).getAttribute("data-visible")).toBe("true");

    advanceTimers(1);
    expect(getViewport(view.container).getAttribute("data-visible")).toBe("false");
  });

  it("a new toast replaces the current one instead of stacking, and restarts the timer", () => {
    vi.useFakeTimers();
    view = renderProvider();
    act(() => {
      latestToastApi!.showToast("FIRST");
    });
    advanceTimers(2000); // most of the way through the first toast's life
    act(() => {
      latestToastApi!.showToast("SECOND");
    });
    // Only one toast node ever exists (single slot) and it now reads the
    // new message.
    expect(getLiveRegion(view.container).textContent).toBe("SECOND");
    expect(view.container.querySelectorAll('[aria-live="polite"]').length).toBe(1);

    // The timer restarted: 2000ms after the SECOND call (< 2600ms total
    // life) it must still be showing.
    advanceTimers(2000);
    expect(getViewport(view.container).getAttribute("data-visible")).toBe("true");
    expect(getLiveRegion(view.container).textContent).toBe("SECOND");

    // And it clears at SECOND's own 2.6s mark, not FIRST's.
    advanceTimers(600);
    expect(getViewport(view.container).getAttribute("data-visible")).toBe("false");
  });

  it("re-announces an identical consecutive message (forces a DOM mutation via a remounted text node)", () => {
    vi.useFakeTimers();
    view = renderProvider();
    act(() => {
      latestToastApi!.showToast("SAVED");
    });
    const firstNode = getLiveRegion(view.container).querySelectorAll("span")[1];
    advanceTimers(2600);
    expect(getViewport(view.container).getAttribute("data-visible")).toBe("false");

    act(() => {
      latestToastApi!.showToast("SAVED");
    });
    const secondNode = getLiveRegion(view.container).querySelectorAll("span")[1];
    expect(getViewport(view.container).getAttribute("data-visible")).toBe("true");
    expect(getLiveRegion(view.container).textContent).toBe("SAVED");
    // A fresh DOM node, not the same one reused — that's what guarantees
    // assistive tech treats it as a new announcement.
    expect(secondNode).not.toBe(firstNode);
  });

  it("dismiss() clears the toast immediately, before the timer would have", () => {
    vi.useFakeTimers();
    view = renderProvider();
    act(() => {
      latestToastApi!.showToast("SWITCHED TO 1080P SDR");
    });
    expect(getViewport(view.container).getAttribute("data-visible")).toBe("true");
    act(() => {
      latestToastApi!.dismiss();
    });
    expect(getViewport(view.container).getAttribute("data-visible")).toBe("false");
    // The now-cleared timer must not fire some later side effect.
    advanceTimers(3000);
    expect(getViewport(view.container).getAttribute("data-visible")).toBe("false");
  });

  it("honors a custom durationMs override", () => {
    vi.useFakeTimers();
    view = renderProvider();
    act(() => {
      latestToastApi!.showToast("QUICK", { durationMs: 500 });
    });
    advanceTimers(499);
    expect(getViewport(view.container).getAttribute("data-visible")).toBe("true");
    advanceTimers(1);
    expect(getViewport(view.container).getAttribute("data-visible")).toBe("false");
  });

  it("reduced-motion CSS: the toast's rise is removed entirely (no travel), not merely shortened", () => {
    const css = readFileSync(path.join(__dirname, "Toast.module.css"), "utf8");
    const reducedBlockMatch = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
    expect(reducedBlockMatch, "expected a prefers-reduced-motion block in Toast.module.css").not.toBeNull();
    const block = reducedBlockMatch![1]!;
    expect(block).toContain(".viewport");
    expect(block).toContain("translate(-50%, 0)");
  });
});
