// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/watchlist/WatchlistPosterCard.test.tsx
//
// Item 6 (Wave A, poster-card a11y sweep): same defect class
// as PosterCard.test.tsx's header describes — this card's own header
// documents it hosts on BOTH Home's Row horizontal scroller and /watchlist's
// CSS grid, so the Row-scroller clipping risk applies here too.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { WatchlistPosterCard } = await import("./WatchlistPosterCard.js");

describe("WatchlistPosterCard — real anchor semantics", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders as a real <a href>", () => {
    view = renderIntoBody(
      <WatchlistPosterCard
        serverUrl="https://loombre.local"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        href="/items/movie/m1"
        title="Test Movie"
        blurhash={null}
        onRemove={async () => {}}
      />,
    );
    const link = view.container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/items/movie/m1");
  });
});

describe("WatchlistPosterCard — browser-casual-F4: skips the doomed poster request when the item has none", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("does not render a network <img> when hasPoster=false", () => {
    view = renderIntoBody(
      <WatchlistPosterCard
        serverUrl="https://loombre.local"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        href="/items/movie/m1"
        title="Test Movie"
        blurhash={null}
        hasPoster={false}
        onRemove={async () => {}}
      />,
    );
    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(0);
  });

  it("still renders the poster <img> when hasPoster is omitted (default true, back-compat)", () => {
    view = renderIntoBody(
      <WatchlistPosterCard
        serverUrl="https://loombre.local"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        href="/items/movie/m1"
        title="Test Movie"
        blurhash={null}
        onRemove={async () => {}}
      />,
    );
    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(1);
  });
});

describe("WatchlistPosterCard.module.css — focus ring survives a scrolling-rail ancestor (item 6)", () => {
  const css = readFileSync(path.join(__dirname, "WatchlistPosterCard.module.css"), "utf8");

  it(".tile:focus-visible carries an INSET ring", () => {
    const match = /\.tile:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(match, "expected a .tile:focus-visible rule").not.toBeNull();
    expect(match![1]).toMatch(/box-shadow:[^;]*inset/);
  });
});
