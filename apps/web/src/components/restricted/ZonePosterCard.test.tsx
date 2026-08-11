// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/restricted/ZonePosterCard.test.tsx
//
// Item 6 (Wave A, poster-card a11y sweep): same defect class
// as PosterCard.test.tsx's header describes — app/restricted/page.tsx
// renders this card's own Continue-Watching-in-zone rail through the SAME
// Row.tsx horizontal scroller Home uses, so the clipping risk applies here
// too. This card additionally had a *second*, independent attempt at a
// focus indicator (`outline: 2px solid var(--color-focus); outline-offset:
// 2px`) — `outline` is just as clippable by an ancestor's overflow as the
// non-inset box-shadow default is (both are "ink overflow" under the CSS
// Overflow spec), so it doesn't actually solve the problem either; this
// replaces it with the same inset-box-shadow technique the rest of the
// poster-card family uses.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { ZonePosterCard } = await import("./ZonePosterCard.js");

describe("ZonePosterCard — real anchor semantics", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders as a real <a href>", () => {
    view = renderIntoBody(
      <ZonePosterCard
        serverUrl="https://loombre.local"
        accessToken="tok"
        itemId="scene-1"
        itemType="scene"
        title="Test Scene"
        blurhash={null}
        href="/restricted/scenes/scene-1"
      />,
    );
    const link = view.container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/restricted/scenes/scene-1");
  });
});

describe("ZonePosterCard.module.css — focus ring survives a scrolling-rail ancestor (item 6)", () => {
  const css = readFileSync(path.join(__dirname, "ZonePosterCard.module.css"), "utf8");

  it(".tile:focus-visible carries an INSET ring, not a clippable outline", () => {
    const match = /\.tile:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(match, "expected a .tile:focus-visible rule").not.toBeNull();
    expect(match![1]).toMatch(/box-shadow:[^;]*inset/);
    expect(match![1]).not.toMatch(/outline:\s*\d/);
  });
});
