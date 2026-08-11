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

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QualitySelector, describeLevel } from "./QualitySelector.js";

const LEVELS = [
  { height: 360, bitrate: 960_000 },
  { height: 720, bitrate: 3_160_000 },
  { height: 1080, bitrate: 8_384_000 },
];

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
    render(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={() => undefined} />);
    const options = screen.getAllByRole("radio").map((el) => el.textContent);
    expect(options).toEqual(["Auto", "1080p", "720p", "360p"]);
  });

  it("is a RADIOGROUP, not a tablist — mutually exclusive options, per the Wave A sweep", () => {
    render(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={() => undefined} />);
    expect(screen.getByRole("radiogroup", { name: /quality/i })).toBeTruthy();
  });

  it("marks Auto checked in auto mode, and the PINNED level when pinned", () => {
    const { rerender } = render(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={() => undefined} />);
    expect(screen.getByRole("radio", { name: "Auto" }).getAttribute("aria-checked")).toBe("true");

    rerender(<QualitySelector levels={LEVELS} currentLevel={1} autoMode={false} onSelect={() => undefined} />);
    expect(screen.getByRole("radio", { name: "720p" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Auto" }).getAttribute("aria-checked")).toBe("false");
  });

  it("selecting a level reports that level's hls.js INDEX (what nextLevel takes)", () => {
    const onSelect = vi.fn();
    render(<QualitySelector levels={LEVELS} currentLevel={2} autoMode onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("radio", { name: "720p" }));
    // Displayed highest-first, but hls.js indexes ascending by bandwidth —
    // 720p is index 1, and reporting the DISPLAY position (1 by luck here,
    // 2 for 360p) would pin the wrong variant.
    expect(onSelect).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("radio", { name: "360p" }));
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });

  it("selecting Auto reports -1, hls.js's own 'let ABR decide'", () => {
    const onSelect = vi.fn();
    render(<QualitySelector levels={LEVELS} currentLevel={1} autoMode={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("radio", { name: "Auto" }));
    expect(onSelect).toHaveBeenCalledWith(-1);
  });

  it("in auto mode the CURRENTLY-PLAYING level is still shown, so 'Auto' is not a black box", () => {
    render(<QualitySelector levels={LEVELS} currentLevel={1} autoMode onSelect={() => undefined} />);
    expect(screen.getByRole("radio", { name: "Auto" }).getAttribute("data-current-level")).toBe("720p");
  });

  it("renders NOTHING for a single-variant master — there is nothing to choose between", () => {
    const { container } = render(
      <QualitySelector levels={[{ height: 1080, bitrate: 8_000_000 }]} currentLevel={0} autoMode onSelect={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders NOTHING when there are no levels at all (direct-play, or hls.js not attached)", () => {
    const { container } = render(<QualitySelector levels={[]} currentLevel={-1} autoMode onSelect={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });
});
