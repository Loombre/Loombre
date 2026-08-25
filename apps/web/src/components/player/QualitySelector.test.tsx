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

// d3-aq2 (verify-A/browser-player-F8). A pin is a REQUEST — `hls.nextLevel`
// — and hls.js only moves `currentLevel` when it actually switches: ~7s
// after resuming, and never at all while paused. Mirroring `currentLevel`
// therefore left the click with no visible effect: aria-checked (and the
// roving tabindex) stayed on the old segment while focus sat on the new
// one, and the "Currently X" note vanished the instant `autoMode` flipped
// — a dock showing no selection at all. The checked segment now reflects
// what the VIEWER asked for; the note reports what is actually playing.
//
// Each rerender below is exactly what VideoPlayer.tsx's onSelect does
// (`hls.nextLevel = level; setHlsAutoMode(level === -1)`) followed by
// whatever hls.js reported next.
describe("QualitySelector checked segment = the user's PIN (d3-aq2)", () => {
  it("checks the clicked level at once, while hls.js is still playing the old one", () => {
    const onSelect = vi.fn();
    view = renderIntoBody(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={onSelect} />);

    act(() => radioNamed(view!.container, "720p").click());
    expect(onSelect).toHaveBeenCalledWith(1);
    // Pin taken, no switch yet (paused): autoMode off, currentLevel unmoved.
    view.rerender(<QualitySelector levels={LEVELS} currentLevel={2} autoMode={false} onSelect={onSelect} />);

    expect(radioNamed(view.container, "720p").getAttribute("aria-checked"), "the defect: aria-checked stayed on 1080p").toBe("true");
    expect(radioNamed(view.container, "1080p").getAttribute("aria-checked")).toBe("false");
    // The roving tabindex is the same fact: Tab must land on the pin.
    expect(radioNamed(view.container, "720p").tabIndex).toBe(0);
    expect(radios(view.container).filter((el) => el.tabIndex === 0)).toHaveLength(1);
    // ...and the dock still says what is playing right now, so the window
    // between pin and switch shows a selection AND the truth.
    expect(view.container.textContent).toContain("Currently 1080p");
  });

  it("drops the pending note once hls.js has switched to the pinned level", () => {
    const onSelect = vi.fn();
    view = renderIntoBody(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={onSelect} />);
    act(() => radioNamed(view!.container, "720p").click());
    view.rerender(<QualitySelector levels={LEVELS} currentLevel={1} autoMode={false} onSelect={onSelect} />);

    expect(radioNamed(view.container, "720p").getAttribute("aria-checked")).toBe("true");
    // The checked segment already says 720p — no duplicate note.
    expect(view.container.textContent).not.toContain("Currently");
  });

  it("checks Auto the moment Auto is clicked, and keeps naming the level ABR settled on", () => {
    const onSelect = vi.fn();
    view = renderIntoBody(<QualitySelector levels={LEVELS} currentLevel={1} autoMode={false} onSelect={onSelect} />);
    act(() => radioNamed(view!.container, "Auto").click());
    expect(onSelect).toHaveBeenCalledWith(-1);
    view.rerender(<QualitySelector levels={LEVELS} currentLevel={1} autoMode onSelect={onSelect} />);

    expect(radioNamed(view.container, "Auto").getAttribute("aria-checked")).toBe("true");
    expect(view.container.textContent).toContain("Currently 720p");
  });

  it("yields to the player when hls.js goes back to ABR on its own (a re-attach resets the pin)", () => {
    const onSelect = vi.fn();
    view = renderIntoBody(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={onSelect} />);
    act(() => radioNamed(view!.container, "720p").click());
    view.rerender(<QualitySelector levels={LEVELS} currentLevel={2} autoMode={false} onSelect={onSelect} />);
    expect(radioNamed(view.container, "720p").getAttribute("aria-checked")).toBe("true");

    // Recovery reattached hls.js: autoLevelEnabled is true again and the
    // pin no longer exists anywhere. A stale pin must not keep claiming it.
    view.rerender(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={onSelect} />);
    expect(radioNamed(view.container, "Auto").getAttribute("aria-checked")).toBe("true");
    expect(radioNamed(view.container, "720p").getAttribute("aria-checked")).toBe("false");
    expect(view.container.textContent).toContain("Currently 1080p");
  });

  it("keyboard selection pins the same way a click does (SegmentedControl moves focus AND selection)", () => {
    const onSelect = vi.fn();
    view = renderIntoBody(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={onSelect} />);
    // ArrowRight off 1080p moves focus AND selection to the next segment,
    // 720p — the same pin a click on it makes.
    act(() => {
      radioNamed(view!.container, "1080p").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onSelect).toHaveBeenLastCalledWith(1);
    view.rerender(<QualitySelector levels={LEVELS} currentLevel={2} autoMode={false} onSelect={onSelect} />);
    expect(radioNamed(view.container, "720p").getAttribute("aria-checked")).toBe("true");
    expect(radioNamed(view.container, "720p").tabIndex).toBe(0);
  });
});
