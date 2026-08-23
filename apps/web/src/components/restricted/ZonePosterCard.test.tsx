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
//
// QA browser-restricted-settings-F1 (P1) added the client-navigation
// describe below: this tile is the restricted zone's main navigation
// affordance (the /restricted/browse wall, a studio's Catalog, a
// performer's Filmography, the zone home rails all render it), and it used
// to be a raw `<a href>` — a FULL DOCUMENT navigation. RestrictedProvider
// re-initializes to locked=true on every document load and nothing
// rehydrates the still-live server-side unlock window, so every poster
// click dropped the user back at the PIN gate and burned one of the 5
// unlock attempts/min the server allows. Staying in one document is what
// keeps the unlocked zone unlocked.
//
// The next/link stub mirrors PlayLink.test.tsx's (same reason: vitest
// resolves the bare "next/link" specifier to Next's PAGES build, so the
// shipped App Router Link cannot intercept clicks under jsdom). It models
// exactly what the real component does on an unmodified primary click —
// preventDefault() then a client-side router navigation — so the assertion
// lands on the observable difference the defect is made of.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Records what a real next/link click would hand to the client router.
 *  `vi.hoisted` so the (hoisted) vi.mock factory can close over it. */
const clientNav = vi.hoisted(() => ({ pushes: [] as string[] }));
const routerPushes: string[] = [];

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      routerPushes.push(href);
    },
  }),
}));

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
        // the browser's default (new tab/window), everything else becomes
        // a client-side navigation.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        clientNav.pushes.push(href);
      }}
    >
      {children}
    </a>
  ),
}));

const { ZonePosterCard } = await import("./ZonePosterCard.js");

const HREF = "/restricted/scenes/scene-1";

function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(event);
  return event;
}

function renderCard(extra: { playHref?: string } = {}): TestRender {
  return renderIntoBody(
    <ZonePosterCard
      serverUrl="https://loombre.local"
      accessToken="tok"
      itemId="scene-1"
      itemType="scene"
      title="Test Scene"
      blurhash={null}
      href={HREF}
      {...extra}
    />,
  );
}

describe("ZonePosterCard — real anchor semantics", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders as a real <a href>", () => {
    view = renderCard();
    const link = view.container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(HREF);
  });
});

describe("ZonePosterCard — client-side navigation (QA browser-restricted-settings-F1)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    clientNav.pushes.length = 0;
    routerPushes.length = 0;
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("REGRESSION GUARD: a plain click navigates INSIDE the document, so the unlocked zone survives", () => {
    view = renderCard();
    const anchor = view.container.querySelector("a");
    expect(anchor).not.toBeNull();

    const event = click(anchor as Element);

    // A raw <a href> leaves the click to the browser: the document reloads,
    // RestrictedProvider re-initializes to locked=true, and the scene
    // detail renders the PIN gate instead of the scene.
    expect(event.defaultPrevented).toBe(true);
    expect(clientNav.pushes).toEqual([HREF]);
  });

  it("leaves a modified (cmd/ctrl) click to the browser", () => {
    view = renderCard();
    const event = click(view.container.querySelector("a") as Element, { metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(clientNav.pushes).toEqual([]);
  });

  it("still routes the nested play button to playHref, not to the tile's own href", () => {
    view = renderCard({ playHref: "/watch/scene-1" });
    const button = view.container.querySelector("button");
    expect(button).not.toBeNull();

    click(button as Element);

    expect(routerPushes).toEqual(["/watch/scene-1"]);
    expect(clientNav.pushes).toEqual([]);
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
