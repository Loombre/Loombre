// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/player/QualitySelector.test.tsx
//
// Wave C2 (docs/PLAYBACK.md §9.1.9): "Manual quality selection is a
// client-side affordance over the same mechanism: a player-UI selector
// listing `hls.levels` and setting `hls.nextLevel` (pin) or `-1` (auto). No
// server surface — a manual pin is just a `v{K}` request stream like any
// other."
//
// That sentence is the whole contract, and it is why these tests assert on
// what the component CALLS rather than on anything it fetches: there is no
// endpoint here to test. The selector's only job is to move `nextLevel`.
//
// Rendered through the repo's own `renderIntoBody` harness — this workspace
// deliberately carries no @testing-library (components/ui/test-render.tsx's
// header: HARD LINE, no new npm deps for the player/UI lanes).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";
import { QualitySelector, describeLevel } from "./QualitySelector.js";

const LEVELS = [
  { height: 360, bitrate: 960_000 },
  { height: 720, bitrate: 3_160_000 },
  { height: 1080, bitrate: 8_384_000 },
];

let view: TestRender | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

function radios(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

function radioNamed(container: HTMLElement, label: string): HTMLButtonElement {
  const found = radios(container).find((el) => el.textContent === label);
  expect(found, `expected a radio labelled "${label}"`).toBeDefined();
  return found!;
}

describe("describeLevel", () => {
  it("names a level by its height, which is what a viewer actually recognises", () => {
    expect(describeLevel({ height: 1080, bitrate: 8_384_000 })).toBe("1080p");
    expect(describeLevel({ height: 360, bitrate: 960_000 })).toBe("360p");
  });

  it("falls back to a bitrate when a variant declares no RESOLUTION (audio-only masters)", () => {
    expect(describeLevel({ height: 0, bitrate: 320_000 })).toBe("320 kbps");
    expect(describeLevel({ height: 0, bitrate: 8_384_000 })).toBe("8384 kbps");
  });
});

describe("QualitySelector", () => {
  it("renders Auto plus one option per level, HIGHEST first (how a viewer reads a quality menu)", () => {
    view = renderIntoBody(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={() => undefined} />);
    expect(radios(view.container).map((el) => el.textContent)).toEqual(["Auto", "1080p", "720p", "360p"]);
  });

  it("is a RADIOGROUP, not a tablist — mutually exclusive options, per the Wave A sweep", () => {
    view = renderIntoBody(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={() => undefined} />);
    const group = view.container.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(group!.getAttribute("aria-label")).toBe("Quality");
    // Exactly one segment in the tab order at a time (roving tabindex).
    expect(radios(view.container).filter((el) => el.tabIndex === 0)).toHaveLength(1);
  });

  it("marks Auto checked in auto mode, and the PINNED level when pinned", () => {
    view = renderIntoBody(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={() => undefined} />);
    expect(radioNamed(view.container, "Auto").getAttribute("aria-checked")).toBe("true");

    view.rerender(<QualitySelector levels={LEVELS} currentLevel={1} autoMode={false} onSelect={() => undefined} />);
    expect(radioNamed(view.container, "720p").getAttribute("aria-checked")).toBe("true");
    expect(radioNamed(view.container, "Auto").getAttribute("aria-checked")).toBe("false");
  });

  it("selecting a level reports that level's hls.js INDEX (what nextLevel takes)", () => {
    const onSelect = vi.fn();
    view = renderIntoBody(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={onSelect} />);
    // Displayed highest-first, but hls.js indexes ascending by bandwidth —
    // 720p is index 1 and 360p is index 0. Reporting the DISPLAY position
    // would pin the wrong variant, and (a switch being a full server-side
    // pipeline handoff) pay real CPU to do it.
    act(() => radioNamed(view!.container, "720p").click());
    expect(onSelect).toHaveBeenCalledWith(1);
    act(() => radioNamed(view!.container, "360p").click());
    expect(onSelect).toHaveBeenLastCalledWith(0);
    act(() => radioNamed(view!.container, "1080p").click());
    expect(onSelect).toHaveBeenLastCalledWith(2);
  });

  it("selecting Auto reports -1, hls.js's own 'let ABR decide'", () => {
    const onSelect = vi.fn();
    view = renderIntoBody(<QualitySelector levels={LEVELS} currentLevel={1} autoMode={false} onSelect={onSelect} />);
    act(() => radioNamed(view!.container, "Auto").click());
    expect(onSelect).toHaveBeenCalledWith(-1);
  });

  it("in auto mode the CURRENTLY-PLAYING level is still shown, so 'Auto' is not a black box", () => {
    view = renderIntoBody(<QualitySelector levels={LEVELS} currentLevel={1} autoMode onSelect={() => undefined} />);
    expect(view.container.textContent).toContain("Currently 720p");
  });

  it("that note is absent when a level is PINNED — the chosen segment already says it", () => {
    view = renderIntoBody(<QualitySelector levels={LEVELS} currentLevel={1} autoMode={false} onSelect={() => undefined} />);
    expect(view.container.textContent).not.toContain("Currently");
  });

  it("renders NOTHING for a single-variant master — there is nothing to choose between", () => {
    view = renderIntoBody(
      <QualitySelector levels={[{ height: 1080, bitrate: 8_000_000 }]} currentLevel={0} autoMode onSelect={() => undefined} />,
    );
    expect(view.container.firstChild).toBeNull();
  });

  it("renders NOTHING when there are no levels at all (direct-play, or hls.js not attached)", () => {
    view = renderIntoBody(<QualitySelector levels={[]} currentLevel={-1} autoMode onSelect={() => undefined} />);
    expect(view.container.firstChild).toBeNull();
  });
});
