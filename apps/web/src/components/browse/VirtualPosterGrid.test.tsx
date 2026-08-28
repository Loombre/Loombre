// SPDX-License-Identifier: AGPL-3.0-only

// jsdom implements neither ResizeObserver nor real layout (clientWidth/
// clientHeight always read 0 — no layout engine) — both are stubbed here so
// the grid's own synchronous ResizeObserver seed (see this component's
// header comment on why the seed is synchronous) picks up a real, non-zero
// box instead of getting stuck at width 0 forever.
//
// jsdom does not implement window.matchMedia either (verified against this
// repo's jsdom 29.1.1 — see SheetOrModal.test.tsx's header), and the grid
// now reads it unconditionally for LD-14 (rc.6)'s phone two-up clamp, so a
// minimal fake is installed alongside. `phoneMatches` below is the dial the
// LD-14 cases turn; it resets to false (desktop) after every test so the
// baseline cases keep running exactly as they did before.

import { act } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualPosterGrid } from "./VirtualPosterGrid.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

interface Item {
  id: string;
}

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let originalClientWidth: PropertyDescriptor | undefined;
let originalClientHeight: PropertyDescriptor | undefined;

// The scroll container's measured box. 800x900 is the suite's long-standing
// desktop default; the LD-14 cases override the width per test to model a
// phone's AppShell content box (viewport - 2 * --space-md).
let stubClientWidth = 800;
let stubClientHeight = 900;

// Whether the LD-14 phone two-up media query currently matches.
let phoneMatches = false;

type MediaListener = (event: { matches: boolean }) => void;

beforeAll(() => {
  originalClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
  originalClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => stubClientWidth });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => stubClientHeight });
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return query === PHONE_TWO_UP_QUERY ? phoneMatches : false;
      },
      media: query,
      addEventListener: (_type: string, _listener: MediaListener) => {},
      removeEventListener: (_type: string, _listener: MediaListener) => {},
      addListener: (_listener: MediaListener) => {},
      removeListener: (_listener: MediaListener) => {},
      dispatchEvent: () => true,
    })),
  );
});

afterAll(() => {
  if (originalClientWidth) Object.defineProperty(Element.prototype, "clientWidth", originalClientWidth);
  if (originalClientHeight) Object.defineProperty(Element.prototype, "clientHeight", originalClientHeight);
  vi.unstubAllGlobals();
});

function items(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({ id: `item-${i}` }));
}

// Must match VirtualPosterGrid.tsx's own literal exactly — the fake
// matchMedia above only reports `phoneMatches` for this one query, so a
// drift here shows up as "the clamp never engages" rather than silently
// passing.
const PHONE_TWO_UP_QUERY = "(max-width: 479.98px)";
const GAP = 16; // DEFAULT_GAP — matches --space-md

/** Column geometry as actually stamped on the cells: the distinct
 *  translate-X offsets (one per column, ascending) and the inline widths. */
function cellGeometry(view: TestRender): { columnLefts: number[]; widths: string[] } {
  const cells = Array.from(view.container.querySelectorAll<HTMLElement>('[role="listitem"]'));
  const lefts = cells.map((el) => {
    const match = /translate\((-?[\d.]+)px,/.exec(el.style.transform);
    return match ? Number(match[1]) : Number.NaN;
  });
  return {
    columnLefts: [...new Set(lefts)].sort((a, b) => a - b),
    widths: [...new Set(cells.map((el) => el.style.width))],
  };
}

function renderGrid(props: { phoneTwoUp?: boolean }): TestRender {
  // renderIntoBody already wraps root.render in React's `act`, so the
  // component's synchronous ResizeObserver width seed has been applied by
  // the time this returns.
  return renderIntoBody(
    <VirtualPosterGrid<Item>
      items={items(8)}
      hasMore={false}
      loadingMore={false}
      loading={false}
      onLoadMore={() => {}}
      getKey={(item) => item.id}
      renderItem={(item) => <span>{item.id}</span>}
      ariaLabel="Test items"
      {...props}
    />,
  );
}

describe("VirtualPosterGrid — onLoadMore auto-fire gating", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("fires onLoadMore when the rendered window nears the loaded end (baseline)", () => {
    const onLoadMore = vi.fn();
    act(() => {
      view = renderIntoBody(
        <VirtualPosterGrid<Item>
          items={items(4)}
          hasMore
          loadingMore={false}
          loading={false}
          onLoadMore={onLoadMore}
          getKey={(item) => item.id}
          renderItem={(item) => <span>{item.id}</span>}
          ariaLabel="Test items"
        />,
      );
    });

    expect(onLoadMore).toHaveBeenCalled();
  });

  it("does not auto-fire onLoadMore while loadMoreError is set — no retry storm against a failing endpoint", () => {
    const onLoadMore = vi.fn();
    act(() => {
      view = renderIntoBody(
        <VirtualPosterGrid<Item>
          items={items(4)}
          hasMore
          loadingMore={false}
          loading={false}
          loadMoreError="Failed to load more."
          onLoadMore={onLoadMore}
          getKey={(item) => item.id}
          renderItem={(item) => <span>{item.id}</span>}
          ariaLabel="Test items"
        />,
      );
    });

    expect(onLoadMore).not.toHaveBeenCalled();
  });
});

// LD-14 (rc.6): below the 479.98px phone breakpoint the Browse grid shows
// exactly two poster columns instead of the one 348px-wide jumbo poster the
// shared 168px auto-fit math yields at a 380px viewport. Opt-in, because
// this component also draws the three restricted-zone poster walls
// (ZoneBrowseGrid), which keep today's behavior.
//
// The container widths below are AppShell content boxes, not viewports:
// .main's mobile padding is calc(var(--space-md) + env(safe-area-inset-*))
// on both sides, so a 380px viewport measures 380 - 16 - 16 = 348px.
describe("VirtualPosterGrid — LD-14 (rc.6) phone two-up columns", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    stubClientWidth = 800;
    stubClientHeight = 900;
    phoneMatches = false;
  });

  const phoneWidths: { viewport: number; contentBox: number }[] = [
    { viewport: 380, contentBox: 348 },
    { viewport: 412, contentBox: 380 },
    { viewport: 479, contentBox: 447 },
  ];

  for (const { viewport, contentBox } of phoneWidths) {
    it(`lays out exactly two columns at a ${viewport}px viewport (${contentBox}px content box) when opted in`, () => {
      stubClientWidth = contentBox;
      phoneMatches = true;

      view = renderGrid({ phoneTwoUp: true });

      const { columnLefts, widths } = cellGeometry(view);
      const expectedWidth = (contentBox - GAP) / 2;
      expect(columnLefts).toEqual([0, expectedWidth + GAP]);
      expect(widths).toEqual([`${expectedWidth}px`]);
    });
  }

  it("resumes the shared computeColumns math when the phone query does not match (>= 480px)", () => {
    // computeColumns(800, 168, 16) = floor(816 / 184) = 4 columns;
    // actualItemWidth = (800 - 16 * 3) / 4 = 188px.
    stubClientWidth = 800;
    phoneMatches = false;

    view = renderGrid({ phoneTwoUp: true });

    const { columnLefts, widths } = cellGeometry(view);
    expect(columnLefts).toEqual([0, 204, 408, 612]);
    expect(widths).toEqual(["188px"]);
  });

  it("leaves a caller that does not opt in on today's behavior at the same narrow width (restricted-zone safety)", () => {
    // computeColumns(348, 168, 16) = floor(364 / 184) = 1 — the pre-LD-14
    // jumbo single poster, which ZoneBrowseGrid's three walls keep.
    stubClientWidth = 348;
    phoneMatches = true;

    view = renderGrid({});

    const { columnLefts, widths } = cellGeometry(view);
    expect(columnLefts).toEqual([0]);
    expect(widths).toEqual(["348px"]);
  });
});
