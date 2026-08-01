// SPDX-License-Identifier: AGPL-3.0-only

// S7/K9 (chapter marker ticks on the scrubber rail) — the one piece of
// this component's rendering not already exercised through VideoPlayer.
// test.tsx's full player harness: the tick-position math and the
// zero-chapters/boundary-marker exclusion rules.

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
