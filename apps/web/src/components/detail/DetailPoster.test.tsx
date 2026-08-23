// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/DetailPoster.test.tsx
//
// browser-items-F13: on an item whose own `images[]` already says it has no
// poster (owner's real, un-scanned library — no metadata provider
// configured), DetailPoster still fired a real GET .../poster network
// request that was guaranteed to 404/ORB-block, only reaching the fallback
// on that request's onError. Same "doomed request" class
// browser-shell-browse-F3/browser-casual-F4 already fixed for the browse
// grid's PosterCell (browse/page.tsx's `hasPosterImage`) — this is that
// same fix for the item-detail page's poster, which PosterCell's fix never
// touched.

import { describe, expect, it, afterEach } from "vitest";
import { DetailPoster } from "./DetailPoster.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

describe("DetailPoster", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders a real <img> by default (hasImage omitted — every pre-existing caller keeps working)", () => {
    view = renderIntoBody(
      <DetailPoster
        serverUrl="https://example.test"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        title="Zero Hour"
        blurhash={null}
        dominantColor={null}
      />,
    );
    expect(view.container.querySelectorAll("img")).toHaveLength(1);
    expect(view.container.querySelector('[data-fallback="true"]')).toBeNull();
  });

  it("browser-items-F13 REGRESSION GUARD: hasImage=false skips the doomed network fetch and renders the fallback immediately", () => {
    view = renderIntoBody(
      <DetailPoster
        serverUrl="https://example.test"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        title="Zero Hour"
        blurhash={null}
        dominantColor={null}
        hasImage={false}
      />,
    );
    // No <img> pointed at the poster endpoint was ever mounted — nothing
    // for the browser to request, let alone 404 on.
    expect(view.container.querySelectorAll("img")).toHaveLength(0);
    expect(view.container.querySelector('[data-fallback="true"]')).not.toBeNull();
    expect(view.container.textContent).toContain("Z");
  });
});
