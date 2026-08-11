// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/browse/PosterCell.test.tsx
//
// Item 6 (an upstream media server-study Wave A, poster-card a11y sweep): PosterCell was
// already a real <a href> (roving-tabindex cell, browse's virtualized
// grid), but its focus indicator was the app-wide non-inset ring —
// VirtualPosterGrid.module.css's own scroll container (`overflow: hidden
// auto`, the windowing viewport) can clip it for a cell near the top/
// bottom of that viewport, same defect class as Home's Row scroller (see
// PosterCard.test.tsx's header for the full writeup this mirrors).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { PosterCell } = await import("./PosterCell.js");

describe("PosterCell — real anchor semantics", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders as a real <a href>", () => {
    view = renderIntoBody(
      <PosterCell
        serverUrl="https://loombre.local"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        href="/items/movie/m1"
        title="Test Movie"
        blurhash={null}
        tabIndex={0}
        cellRef={() => {}}
        onFocus={() => {}}
      />,
    );
    const link = view.container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/items/movie/m1");
  });
});

describe("PosterCell.module.css — focus ring survives a scrolling-viewport ancestor (item 6)", () => {
  const css = readFileSync(path.join(__dirname, "PosterCell.module.css"), "utf8");

  it(".tile:focus-visible carries an INSET ring", () => {
    const match = /\.tile:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(match, "expected a .tile:focus-visible rule").not.toBeNull();
    expect(match![1]).toMatch(/box-shadow:[^;]*inset/);
  });
});
