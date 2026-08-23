// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/SceneBanner.test.tsx
//
// Phosphor W3 fidelity-audit regression (fix wave FX1, S5): missing-
// artwork fallback on the desktop scene banner (onError, DetailPoster.
// tsx's established pattern) — a seeded install with no backdrop scanned
// yet used to render a browser broken-image glyph full-bleed across the
// banner.

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SceneBanner } from "./SceneBanner.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

describe("SceneBanner", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders a real <img> and no fallback state by default", () => {
    view = renderIntoBody(
      <SceneBanner serverUrl="https://example.test" accessToken="tok" entityType="movie" entityId="m1" backdropKind="backdrop" desktopHeight={340} />,
    );
    expect(view.container.querySelector("img")).not.toBeNull();
    expect(view.container.querySelector('[data-fallback="true"]')).toBeNull();
  });

  it("REGRESSION GUARD: on the backdrop's error event, removes the broken <img> and renders the gradient + typographic-initial fallback instead", () => {
    view = renderIntoBody(
      <SceneBanner
        serverUrl="https://example.test"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        backdropKind="backdrop"
        desktopHeight={340}
        title="Zero Hour"
      />,
    );

    const img = view.container.querySelector("img");
    expect(img).not.toBeNull();

    act(() => {
      img?.dispatchEvent(new Event("error"));
    });

    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector('[data-fallback="true"]')).not.toBeNull();
    expect(view.container.textContent).toContain("Z");
  });

  it("falls back to a bare '?' initial when no title is supplied (optional prop — see this component's header)", () => {
    view = renderIntoBody(
      <SceneBanner serverUrl="https://example.test" accessToken="tok" entityType="movie" entityId="m1" backdropKind="backdrop" desktopHeight={340} />,
    );
    const img = view.container.querySelector("img");
    act(() => {
      img?.dispatchEvent(new Event("error"));
    });
    expect(view.container.textContent).toContain("?");
  });

  it("uses a real per-item dominantColor for the fallback gradient when supplied", () => {
    view = renderIntoBody(
      <SceneBanner
        serverUrl="https://example.test"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        backdropKind="backdrop"
        desktopHeight={340}
        dominantColor="#336699"
      />,
    );
    const banner = view.container.querySelector('[style*="--banner-height"]') as HTMLElement;
    expect(banner.style.getPropertyValue("--banner-glow")).toBe("#336699");
  });

  it("browser-items-F8 REGRESSION GUARD: the '← LIBRARY' pill links back to THIS item's own library, not a hard-coded /browse", () => {
    view = renderIntoBody(
      <SceneBanner
        serverUrl="https://example.test"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        backdropKind="backdrop"
        desktopHeight={340}
        libraryId="lib-42"
      />,
    );
    const pill = view.container.querySelector("a") as HTMLAnchorElement;
    expect(pill.getAttribute("href")).toBe("/browse?library=lib-42");
  });

  it("still renders the '← LIBRARY' back pill and overlay content in the fallback state", () => {
    view = renderIntoBody(
      <SceneBanner
        serverUrl="https://example.test"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        backdropKind="backdrop"
        desktopHeight={340}
        overlay={<span>MOVIE OVERLAY</span>}
      />,
    );
    const img = view.container.querySelector("img");
    act(() => {
      img?.dispatchEvent(new Event("error"));
    });
    expect(view.container.textContent).toContain("LIBRARY");
    expect(view.container.textContent).toContain("MOVIE OVERLAY");
  });
});
