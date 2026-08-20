// SPDX-License-Identifier: AGPL-3.0-only

// S7/K9 (chapter marker ticks on the scrubber rail) — the one piece of
// this component's rendering not already exercised through VideoPlayer.
// test.tsx's full player harness: the tick-position math and the
// zero-chapters/boundary-marker exclusion rules.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scrubber } from "./Scrubber.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

describe("Scrubber chapter ticks", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders no ticks when chapters is omitted (zero chapters -> zero UI)", () => {
    view = renderIntoBody(<Scrubber positionMs={0} durationMs={600_000} onSeek={vi.fn()} />);
    expect(view.container.querySelectorAll('[class*="chapterTick"]')).toHaveLength(0);
  });

  it("positions a tick at its proportional offset along the rail", () => {
    // 150_000ms of a 600_000ms duration -> 25%.
    view = renderIntoBody(
      <Scrubber positionMs={0} durationMs={600_000} chapters={[{ startMs: 150_000 }]} onSeek={vi.fn()} />,
    );
    const tick = view.container.querySelector<HTMLElement>('[class*="chapterTick"]');
    expect(tick).toBeTruthy();
    expect(tick?.style.left).toBe("25%");
  });

  it("excludes a marker at startMs 0 or at/beyond the track's own duration — nothing meaningful to divide there", () => {
    view = renderIntoBody(
      <Scrubber
        positionMs={0}
        durationMs={600_000}
        chapters={[{ startMs: 0 }, { startMs: 600_000 }, { startMs: 700_000 }, { startMs: 300_000 }]}
        onSeek={vi.fn()}
      />,
    );
    const ticks = view.container.querySelectorAll<HTMLElement>('[class*="chapterTick"]');
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.style.left).toBe("50%");
  });

  it("renders no ticks while duration is unknown (null), regardless of chapters passed in", () => {
    view = renderIntoBody(<Scrubber positionMs={0} durationMs={null} chapters={[{ startMs: 150_000 }]} onSeek={vi.fn()} />);
    expect(view.container.querySelectorAll('[class*="chapterTick"]')).toHaveLength(0);
  });
});

describe("Scrubber commit-on-release (V8, docs/PLAYBACK.md §9.1.9)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.restoreAllMocks();
  });

  function track(v: TestRender): HTMLElement {
    const el = v.container.querySelector<HTMLElement>('[role="slider"]');
    if (!el) throw new Error("no slider rendered");
    // jsdom: no layout, no pointer capture — give the track a 1000px-wide
    // rect so clientX maps 1:1 to permille of the duration.
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 1000, bottom: 10, width: 1000, height: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    (el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => undefined;
    return el;
  }

  function pointer(el: HTMLElement, type: string, clientX: number): void {
    // jsdom has no PointerEvent constructor — a MouseEvent with the right
    // type name reaches React's onPointer* handlers identically. act():
    // the drag flow depends on setDragging/setDragMs committing between
    // dispatches.
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
    });
  }

  it("a drag fires ZERO seeks until release, then exactly ONE at the release position", () => {
    const onSeek = vi.fn();
    view = renderIntoBody(<Scrubber positionMs={500_000} durationMs={1_000_000} onSeek={onSeek} />);
    const el = track(view);

    pointer(el, "pointerdown", 100);
    pointer(el, "pointermove", 200);
    pointer(el, "pointermove", 300);
    pointer(el, "pointermove", 400);
    expect(onSeek, "the pre-V8 defect: a seek per pointermove").not.toHaveBeenCalled();

    pointer(el, "pointerup", 400);
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(400_000);
  });

  it("the preview position tracks the drag (aria-valuenow) while the commit waits for release", () => {
    const onSeek = vi.fn();
    view = renderIntoBody(<Scrubber positionMs={500_000} durationMs={1_000_000} onSeek={onSeek} />);
    const el = track(view);

    pointer(el, "pointerdown", 250);
    expect(el.getAttribute("aria-valuenow")).toBe("250000");
    pointer(el, "pointermove", 750);
    expect(el.getAttribute("aria-valuenow")).toBe("750000");
    expect(onSeek).not.toHaveBeenCalled();

    pointer(el, "pointerup", 750);
    expect(onSeek).toHaveBeenCalledWith(750_000);
    // Preview released — back to the real position.
    expect(el.getAttribute("aria-valuenow")).toBe("500000");
  });

  it("a cancelled drag commits nothing and snaps the preview back", () => {
    const onSeek = vi.fn();
    view = renderIntoBody(<Scrubber positionMs={500_000} durationMs={1_000_000} onSeek={onSeek} />);
    const el = track(view);

    pointer(el, "pointerdown", 100);
    pointer(el, "pointermove", 900);
    pointer(el, "pointercancel", 900);
    expect(onSeek).not.toHaveBeenCalled();
    expect(el.getAttribute("aria-valuenow")).toBe("500000");
    // A later pointerup outside a drag also commits nothing.
    pointer(el, "pointerup", 900);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("keyboard arrows stay single-shot commits (unchanged)", () => {
    const onSeek = vi.fn();
    view = renderIntoBody(<Scrubber positionMs={500_000} durationMs={1_000_000} onSeek={onSeek} />);
    const el = track(view);
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(505_000);
  });
});
