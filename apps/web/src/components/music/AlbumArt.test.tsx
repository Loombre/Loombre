// SPDX-License-Identifier: AGPL-3.0-only
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AlbumArt } from "./AlbumArt.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

describe("AlbumArt", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders the real artwork <img> by default (no fallback shown yet)", () => {
    view = renderIntoBody(
      <AlbumArt
        serverUrl="https://loombre.local"
        accessToken="tok"
        albumId="album-1"
        title="Night Drive Tapes"
        blurhash={null}
        dominantColor={null}
        size={230}
        spinning={false}
      />,
    );
    expect(view.container.querySelector("img")).not.toBeNull();
    expect(view.container.textContent).not.toContain("N");
  });

  it("falls back to a gradient + oversized initial letter on a real decode error", () => {
    view = renderIntoBody(
      <AlbumArt
        serverUrl="https://loombre.local"
        accessToken="tok"
        albumId="album-1"
        title="Night Drive Tapes"
        blurhash={null}
        dominantColor={null}
        size={230}
        spinning={false}
      />,
    );
    const img = view.container.querySelector("img.image, img:not([aria-hidden])") as HTMLImageElement;
    act(() => {
      img.dispatchEvent(new Event("error"));
    });
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.textContent).toBe("N");
  });

  it("the vinyl ring is present but only ROTATES while `spinning` is true", () => {
    view = renderIntoBody(
      <AlbumArt
        serverUrl="https://loombre.local"
        accessToken="tok"
        albumId="album-1"
        title="Night Drive Tapes"
        blurhash={null}
        dominantColor={null}
        size={230}
        spinning={false}
      />,
    );
    const ring = view.container.querySelector('[data-spinning]');
    expect(ring).not.toBeNull();
    expect(ring?.getAttribute("data-spinning")).toBe("false");

    view.rerender(
      <AlbumArt
        serverUrl="https://loombre.local"
        accessToken="tok"
        albumId="album-1"
        title="Night Drive Tapes"
        blurhash={null}
        dominantColor={null}
        size={230}
        spinning={true}
      />,
    );
    expect(view.container.querySelector('[data-spinning]')?.getAttribute("data-spinning")).toBe("true");
  });

  it("omits the vinyl ring entirely when showVinyl is false (mobile 118px tile)", () => {
    view = renderIntoBody(
      <AlbumArt
        serverUrl="https://loombre.local"
        accessToken="tok"
        albumId="album-1"
        title="Night Drive Tapes"
        blurhash={null}
        dominantColor={null}
        size={118}
        spinning={false}
        showVinyl={false}
      />,
    );
    expect(view.container.querySelector('[data-spinning]')).toBeNull();
  });
});
