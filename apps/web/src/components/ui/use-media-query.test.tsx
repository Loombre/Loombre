// SPDX-License-Identifier: AGPL-3.0-only

// jsdom does not implement window.matchMedia — see SheetOrModal.test.tsx's
// header for the same note.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "./use-media-query.js";
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

let lastValue: boolean | null = null;
function Probe({ query }: { query: string }): null {
  lastValue = useMediaQuery(query);
  return null;
}

describe("useMediaQuery", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
    lastValue = null;
  });

  it("reflects the initial matchMedia() result", () => {
    installMatchMedia(true);
    view = renderIntoBody(<Probe query="(max-width: 640px)" />);
    expect(lastValue).toBe(true);
  });

  it("updates when the media query change event fires", () => {
    const media = installMatchMedia(false);
    view = renderIntoBody(<Probe query="(max-width: 640px)" />);
    expect(lastValue).toBe(false);

    media.setMatches(true);
    expect(lastValue).toBe(true);

    media.setMatches(false);
    expect(lastValue).toBe(false);
  });
});
