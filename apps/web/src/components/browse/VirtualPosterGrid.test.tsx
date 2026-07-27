// SPDX-License-Identifier: AGPL-3.0-only

// jsdom implements neither ResizeObserver nor real layout (clientWidth/
// clientHeight always read 0 — no layout engine) — both are stubbed here so
// the grid's own synchronous ResizeObserver seed (see this component's
// header comment on why the seed is synchronous) picks up a real, non-zero
// box instead of getting stuck at width 0 forever.

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

beforeAll(() => {
  originalClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
  originalClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, value: 900 });
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterAll(() => {
  if (originalClientWidth) Object.defineProperty(Element.prototype, "clientWidth", originalClientWidth);
  if (originalClientHeight) Object.defineProperty(Element.prototype, "clientHeight", originalClientHeight);
  vi.unstubAllGlobals();
});

function items(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({ id: `item-${i}` }));
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
