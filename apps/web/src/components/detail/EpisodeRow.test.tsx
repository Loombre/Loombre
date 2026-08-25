// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/EpisodeRow.test.tsx
//
// Phosphor W3 fidelity-audit regressions (fix wave FX1):
//   S5 — missing-artwork fallback on the episode thumbnail (onError,
//        DetailPoster.tsx's established pattern).
//   H13 — the inProgress&&!watched RESUME mm:ss pill, which used to
//        render nothing at all.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { EpisodeRow } from "./EpisodeRow.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

/** Records what a real next/link click would hand to the client router. */
const clientNav = vi.hoisted(() => ({ pushes: [] as string[] }));

// The next/link stub mirrors PlayLink.test.tsx's and the restricted-scene
// guard's (same reason: vitest resolves the bare "next/link" specifier to
// Next's PAGES build, so the shipped App Router Link cannot intercept
// clicks under jsdom). It models what the real component does on an
// unmodified primary click: preventDefault() then a client-side navigation.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>): React.JSX.Element => (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        clientNav.pushes.push(href);
      }}
    >
      {children}
    </a>
  ),
}));

function click(node: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => {
    node.dispatchEvent(event);
  });
  return event;
}

type Episode = components["schemas"]["Episode"];
type Progress = components["schemas"]["Progress"];

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    libraryId: "22222222-2222-2222-2222-222222222222",
    itemType: "episode",
    title: "The Pilot",
    sortTitle: "pilot",
    year: 2020,
    communityRating: null,
    contentClass: "general",
    addedAtMs: 0,
    updatedAtMs: 0,
    seasonId: "33333333-3333-3333-3333-333333333333",
    seriesId: "44444444-4444-4444-4444-444444444444",
    episodeNumber: 4,
    runtimeMs: 42 * 60_000,
    overview: null,
    images: [],
    ...overrides,
  };
}

function makeProgress(overrides: Partial<Progress> = {}): Progress {
  return {
    itemId: "11111111-1111-1111-1111-111111111111",
    positionMs: 0,
    durationMs: null,
    state: "in-progress",
    playCount: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

describe("EpisodeRow", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    clientNav.pushes.length = 0;
  });

  it("renders the index, title, and runtime", () => {
    const episode = makeEpisode();
    view = renderIntoBody(<EpisodeRow episode={episode} serverUrl="https://example.test" accessToken="tok" />);
    expect(view.container.textContent).toContain("E04");
    expect(view.container.textContent).toContain("The Pilot");
    expect(view.container.textContent).toContain("42m");
  });

  describe("S5: missing-artwork fallback", () => {
    it("renders a real <img> when the thumbnail hasn't failed, with no fallback state active", () => {
      const episode = makeEpisode();
      view = renderIntoBody(<EpisodeRow episode={episode} serverUrl="https://example.test" accessToken="tok" />);
      expect(view.container.querySelector("img")).not.toBeNull();
      expect(view.container.querySelector('[data-fallback="true"]')).toBeNull();
    });

    it("REGRESSION GUARD: on the thumbnail's error event, removes the broken <img> and renders the gradient + typographic-initial fallback instead (DetailPoster.tsx's established pattern)", () => {
      const episode = makeEpisode({ title: "Zero Hour" });
      view = renderIntoBody(<EpisodeRow episode={episode} serverUrl="https://example.test" accessToken="tok" />);

      const img = view.container.querySelector("img");
      expect(img).not.toBeNull();

      act(() => {
        img?.dispatchEvent(new Event("error"));
      });

      expect(view.container.querySelector("img")).toBeNull(); // broken <img> gone, no broken-image glyph
      expect(view.container.querySelector('[data-fallback="true"]')).not.toBeNull();
      expect(view.container.textContent).toContain("Z"); // the typographic initial
    });

    it("uses the real per-episode dominantColor (from episode.images' thumb descriptor) for the fallback gradient when one is known", () => {
      const episode = makeEpisode({
        images: [{ kind: "thumb", width: 320, height: 180, blurhash: null, dominantColor: "#336699" }],
      });
      view = renderIntoBody(<EpisodeRow episode={episode} serverUrl="https://example.test" accessToken="tok" />);
      const img = view.container.querySelector("img");
      act(() => {
        img?.dispatchEvent(new Event("error"));
      });
      const thumbWrap = view.container.querySelector('[data-fallback="true"]') as HTMLElement;
      expect(thumbWrap.style.getPropertyValue("--thumb-glow")).toBe("#336699");
    });
  });

  describe("H13: RESUME pill + hover scrim structure", () => {
    it("REGRESSION GUARD: inProgress && !watched renders an accent RESUME mm:ss pill with the real position (this branch used to render nothing)", () => {
      const episode = makeEpisode();
      const progress = makeProgress({ state: "in-progress", positionMs: 65_000 }); // 1:05
      view = renderIntoBody(
        <EpisodeRow episode={episode} serverUrl="https://example.test" accessToken="tok" progress={progress} />,
      );
      expect(view.container.textContent).toContain("RESUME 1:05");
    });

    it("formats past the hour mark as h:mm:ss", () => {
      const episode = makeEpisode();
      const progress = makeProgress({ state: "in-progress", positionMs: (60 * 60 + 5 * 60 + 9) * 1000 }); // 1:05:09
      view = renderIntoBody(
        <EpisodeRow episode={episode} serverUrl="https://example.test" accessToken="tok" progress={progress} />,
      );
      expect(view.container.textContent).toContain("RESUME 1:05:09");
    });

    it("watched (progress.state === 'played') still renders WATCHED, never the RESUME pill", () => {
      const episode = makeEpisode();
      const progress = makeProgress({ state: "played", positionMs: 42_000 });
      view = renderIntoBody(
        <EpisodeRow episode={episode} serverUrl="https://example.test" accessToken="tok" progress={progress} />,
      );
      expect(view.container.textContent).toContain("WATCHED");
      expect(view.container.textContent).not.toContain("RESUME");
    });

    it("no progress at all still renders the unseen dot, never the RESUME pill", () => {
      const episode = makeEpisode();
      view = renderIntoBody(<EpisodeRow episode={episode} serverUrl="https://example.test" accessToken="tok" progress={null} />);
      expect(view.container.textContent).not.toContain("RESUME");
      expect(view.container.textContent).not.toContain("WATCHED");
    });

    it("renders a play-glyph hover-scrim layer over the thumbnail (structural presence — the CSS module owns the opacity/hover transition itself)", () => {
      const episode = makeEpisode();
      view = renderIntoBody(<EpisodeRow episode={episode} serverUrl="https://example.test" accessToken="tok" />);
      // The play icon renders inside its own dedicated wrapper span (sibling
      // of the <img>), not as a bare icon directly on the thumbnail — that
      // wrapper is what carries the rgba(11,12,15,.45) scrim background.
      const thumbWrap = view.container.querySelector('a[href$="/items/episode/11111111-1111-1111-1111-111111111111"] > span:nth-child(2)');
      expect(thumbWrap?.querySelector("svg")).not.toBeNull();
    });
  });

  // d4-w5 (C/detail-back-links-raw-anchor): every episode row on a series
  // detail was a raw <a href>, i.e. a FULL DOCUMENT load of an app already
  // loaded — and a re-lock when the series was reached from the unlocked
  // restricted zone.
  it("d4-w5: an episode row click is a CLIENT navigation, not a document load", () => {
    const episode = makeEpisode();
    view = renderIntoBody(<EpisodeRow episode={episode} serverUrl="https://example.test" accessToken="tok" />);
    const row = view.container.querySelector("a") as Element;

    const event = click(row);

    expect(event.defaultPrevented).toBe(true);
    expect(clientNav.pushes).toEqual([`/items/episode/${episode.id}`]);
  });
});
