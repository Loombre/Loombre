// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/MobileSceneCard.test.tsx
//
// Phosphor W3 fidelity-audit regression (fix wave FX1, S5): missing-
// artwork fallback on the mobile scene card (onError, DetailPoster.tsx's
// established pattern).

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MobileSceneCard } from "./MobileSceneCard.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

describe("MobileSceneCard", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders a real <img>, the title, and meta line by default", () => {
    view = renderIntoBody(
      <MobileSceneCard
        serverUrl="https://example.test"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        backdropKind="backdrop"
        title="Zero Hour"
        metaLine="2020 · 1h 42m"
      />,
    );
    expect(view.container.querySelector("img")).not.toBeNull();
    expect(view.container.querySelector('[data-fallback="true"]')).toBeNull();
    expect(view.container.textContent).toContain("Zero Hour");
    expect(view.container.textContent).toContain("2020 · 1h 42m");
  });

  it("REGRESSION GUARD: on the backdrop's error event, removes the broken <img> and renders the gradient + typographic-initial fallback instead (the real title from the already-wired `title` prop)", () => {
    view = renderIntoBody(
      <MobileSceneCard
        serverUrl="https://example.test"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        backdropKind="backdrop"
        title="Zero Hour"
        metaLine="2020 · 1h 42m"
      />,
    );

    const img = view.container.querySelector("img");
    expect(img).not.toBeNull();

    act(() => {
      img?.dispatchEvent(new Event("error"));
    });

    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector('[data-fallback="true"]')).not.toBeNull();
    expect(view.container.textContent).toContain("Z"); // the typographic initial
    // The real title still renders via .text .title in every state.
    expect(view.container.textContent).toContain("Zero Hour");
  });

  it("uses a real per-item dominantColor for the fallback gradient when supplied", () => {
    view = renderIntoBody(
      <MobileSceneCard
        serverUrl="https://example.test"
        accessToken="tok"
        entityType="movie"
        entityId="m1"
        backdropKind="backdrop"
        title="Zero Hour"
        metaLine="2020"
        dominantColor="#336699"
      />,
    );
    const card = view.container.firstElementChild as HTMLElement;
    expect(card.style.getPropertyValue("--card-glow")).toBe("#336699");
  });
});
