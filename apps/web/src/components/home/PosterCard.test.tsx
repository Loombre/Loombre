// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/home/PosterCard.test.tsx
//
// Item 6 (Wave A, poster-card a11y sweep): PosterCard was
// already a real <a href> (anchor semantics + native Enter-to-navigate come
// for free from that alone), but its focus indicator was the app-wide
// `:focus-visible` rule's NON-inset box-shadow — invisible or clipped for
// any card in the FIRST row of a Home rail, since Row.module.css's
// `.scroller` (`overflow-x: auto`, which per the CSS Overflow spec forces
// `overflow-y` to compute to `auto` too) has no top padding to absorb the
// ring's 3px overshoot. Same defect class Input/Button/SegmentedControl
// already got fixed for (see Input.module.css's header) — root-caused here
// with an inset ring rather than padding-patching every current and future
// scroller.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { PosterCard } = await import("./PosterCard.js");

describe("PosterCard — real anchor semantics", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders as a real <a href> (native keyboard Enter-to-navigate + middle-click/new-tab come from the tag itself, not JS)", () => {
    view = renderIntoBody(
      <PosterCard
        href="/items/movie/m1"
        serverUrl="https://loombre.local"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        title="Test Movie"
        images={[]}
        initial="T"
      />,
    );
    const link = view.container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/items/movie/m1");
  });
});

describe("PosterCard.module.css — focus ring survives a scrolling-rail ancestor (item 6)", () => {
  const css = readFileSync(path.join(__dirname, "PosterCard.module.css"), "utf8");

  it(".tile:focus-visible carries an INSET ring — an ancestor's overflow-x:auto (Row.module.css's .scroller) can never clip it, unlike the app-wide non-inset default it would otherwise fall through to", () => {
    const match = /\.tile:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(match, "expected a .tile:focus-visible rule").not.toBeNull();
    expect(match![1]).toMatch(/box-shadow:[^;]*inset/);
  });
});
