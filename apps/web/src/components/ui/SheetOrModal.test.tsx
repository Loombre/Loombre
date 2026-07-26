// SPDX-License-Identifier: AGPL-3.0-only

// jsdom does not implement window.matchMedia at all ("Not implemented:
// window.matchMedia" — verified against this repo's jsdom 29.1.1 before
// writing this file). Every test below installs a minimal fake so
// use-media-query.ts's addEventListener/removeEventListener calls have
// something to talk to; this is the standard, dependency-free way to test
// matchMedia-driven code under jsdom.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SheetOrModal } from "./SheetOrModal.js";
import { renderIntoBody, type TestRender } from "./test-render.js";

type Listener = (event: { matches: boolean }) => void;

function installMatchMedia(initialMatches: boolean): { setMatches: (next: boolean) => void } {
  const listeners = new Set<Listener>();
  let matches = initialMatches;

  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return matches;
      },
      media: query,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      // Legacy API some code paths still probe for; unused here but cheap
      // to provide for realism.
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => true,
    })),
  );

  return {
    setMatches(next: boolean) {
      matches = next;
      act(() => {
        for (const listener of listeners) listener({ matches: next });
      });
    },
  };
}

describe("SheetOrModal", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  it("renders a BottomSheet (grab handle) when the phone media query matches", () => {
    installMatchMedia(true);
    const onClose = vi.fn();
    view = renderIntoBody(
      <SheetOrModal open onClose={onClose} title="Sheet title">
        <p>body</p>
      </SheetOrModal>,
    );
    expect(view.container.querySelector('[role="presentation"]')).not.toBeNull();
    const dialog = view.container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    // BottomSheet-specific: the grab handle, absent from the desktop dialog.
    expect(view.container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("renders the desktop dialog when the phone media query does not match", () => {
    installMatchMedia(false);
    const onClose = vi.fn();
    view = renderIntoBody(
      <SheetOrModal open onClose={onClose} title="Dialog title">
        <p>body</p>
      </SheetOrModal>,
    );
    const dialog = view.container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(view.container.textContent).toContain("Dialog title");
  });

  it("switches from dialog to sheet when the viewport crosses the breakpoint live", () => {
    const media = installMatchMedia(false);
    const onClose = vi.fn();
    view = renderIntoBody(
      <SheetOrModal open onClose={onClose} title="Responsive">
        <p>body</p>
      </SheetOrModal>,
    );
    // Both branches use role="presentation" on their scrim, so the grab
    // handle (BottomSheet-only, aria-hidden, no equivalent in the desktop
    // dialog) is what actually distinguishes them here.
    expect(view.container.querySelector('[aria-hidden="true"]')).toBeNull();

    media.setMatches(true);
    expect(view.container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("both branches close on Escape", () => {
    for (const isPhone of [true, false]) {
      installMatchMedia(isPhone);
      const onClose = vi.fn();
      const v = renderIntoBody(
        <SheetOrModal open onClose={onClose} title="T">
          <p>body</p>
        </SheetOrModal>,
      );
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      v.unmount();
      vi.unstubAllGlobals();
    }
  });
});
