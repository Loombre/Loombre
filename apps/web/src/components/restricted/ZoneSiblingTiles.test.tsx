// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/restricted/ZoneSiblingTiles.test.tsx
//
// REGRESSION GUARD (QA C/zone-sibling-tiles, follow-up to
// browser-restricted-settings-F1): the three restricted-zone tiles that
// ZonePosterCard.test.tsx's fix did NOT cover — the studios/performers rail
// tiles on the zone home, and the DETAILED-density twin of the browse wall
// (ZoneBrowseGrid renders ZonePosterCard for `wall` and ZoneDetailedRow for
// `rows`, so half the wall still re-locked). All three rendered a raw
// `<a href>`, i.e. a FULL DOCUMENT navigation.
//
// Why a document navigation is a defect HERE specifically: RestrictedProvider
// initializes to locked=true on every document load and has no GET that
// returns {optIn,hasPin,unlockedUntilMs}, so it cannot rehydrate the
// still-live server-side unlock window. Every such click dropped the viewer
// back at the PIN gate and spent one of the 5 unlock attempts/min the server
// allows. Client-side navigation keeps one document — and one provider —
// alive across the whole zone.
//
// The next/link stub mirrors ZonePosterCard.test.tsx's, for the same reason:
// vitest resolves the bare "next/link" specifier to Next's PAGES build, so
// the shipped App Router Link cannot intercept a click under jsdom. It models
// exactly what the real component does on an unmodified primary click —
// preventDefault() then a client-side router navigation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

/** Records what a real next/link click would hand to the client router.
 *  `vi.hoisted` so the (hoisted) vi.mock factory can close over it. */
const clientNav = vi.hoisted(() => ({ pushes: [] as string[] }));

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
        // next/dist/client/link.js `isModifiedEvent`: modified clicks keep
        // the browser's default (new tab/window), everything else becomes a
        // client-side navigation.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        clientNav.pushes.push(href);
      }}
    >
      {children}
    </a>
  ),
}));

const { ZoneStudioTile } = await import("./ZoneStudioTile.js");
const { ZonePerformerTile } = await import("./ZonePerformerTile.js");
const { ZoneDetailedRow } = await import("./ZoneDetailedRow.js");

const STUDIO_HREF = "/restricted/studios/01a02170-2222-7000-8000-00000000bbbb";
const PERFORMER_HREF = "/restricted/performers/01a02170-3333-7000-8000-00000000cccc";
const SCENE_HREF = "/restricted/scenes/01a02170-1111-7000-8000-00000000aaaa";

function browseItem(): components["schemas"]["RestrictedBrowseItem"] {
  return {
    id: "01a02170-1111-7000-8000-00000000aaaa",
    libraryId: "01a02170-4444-7000-8000-00000000dddd",
    itemType: "movie",
    title: "Night Shift",
    sortTitle: "Night Shift",
    year: 2024,
    communityRating: 7.5,
    contentClass: "restricted",
    addedAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    premiereAtMs: null,
    // No blurhash on purpose: the placeholder path would decode one on a
    // canvas, which jsdom has no business doing for a navigation test.
    images: [],
    genres: ["Drama"],
    durationMs: 1_800_000,
    quality: { is4k: false, hdr: "none", resolution: "FHD" },
    studio: { id: "01a02170-2222-7000-8000-00000000bbbb", name: "Blue Room" },
  };
}

function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(event);
  return event;
}

const TILES: Array<{ name: string; href: string; render: () => TestRender }> = [
  {
    name: "ZoneStudioTile",
    href: STUDIO_HREF,
    render: () =>
      renderIntoBody(
        <ZoneStudioTile
          serverUrl="https://loombre.local"
          accessToken="tok"
          studioId="01a02170-2222-7000-8000-00000000bbbb"
          name="Blue Room"
          sceneCount={12}
          hasLogo={false}
          href={STUDIO_HREF}
        />,
      ),
  },
  {
    name: "ZonePerformerTile",
    href: PERFORMER_HREF,
    render: () =>
      renderIntoBody(
        <ZonePerformerTile
          serverUrl="https://loombre.local"
          accessToken="tok"
          performerId="01a02170-3333-7000-8000-00000000cccc"
          name="Ada Vance"
          sceneCount={4}
          hasPortrait={false}
          href={PERFORMER_HREF}
        />,
      ),
  },
  {
    name: "ZoneDetailedRow",
    href: SCENE_HREF,
    render: () =>
      renderIntoBody(<ZoneDetailedRow item={browseItem()} serverUrl="https://loombre.local" accessToken="tok" href={SCENE_HREF} />),
  },
];

describe.each(TILES)("$name — client-side navigation (QA C/zone-sibling-tiles)", ({ href, render }) => {
  let view: TestRender | null = null;

  beforeEach(() => {
    clientNav.pushes.length = 0;
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("REGRESSION GUARD: a plain click navigates INSIDE the document, so the unlocked zone survives", () => {
    view = render();
    const anchor = view.container.querySelector("a");
    expect(anchor).not.toBeNull();

    const event = click(anchor as Element);

    // A raw <a href> leaves the click to the browser: the document reloads,
    // RestrictedProvider re-initializes to locked=true, and the destination
    // renders the PIN gate instead of the zone.
    expect(event.defaultPrevented).toBe(true);
    expect(clientNav.pushes).toEqual([href]);
  });

  it("keeps a real href so middle-click / open-in-new-tab / copy-link still work", () => {
    view = render();
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(href);
  });

  it("leaves a modified (cmd/ctrl) click to the browser", () => {
    view = render();
    const event = click(view.container.querySelector("a") as Element, { metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(clientNav.pushes).toEqual([]);
  });
});
