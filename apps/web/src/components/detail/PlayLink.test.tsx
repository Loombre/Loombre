// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/PlayLink.test.tsx
//
// REGRESSION GUARD (QA browser-items-F1, P1 — "track detail Play does
// nothing"): this affordance MUST reach /watch/{itemId} by a CLIENT-SIDE
// navigation, never by a full document navigation.
//
// Why it matters, mechanically: app/watch/[itemId]/page.tsx's audio branch
// hands the track to the persistent MusicPlayerProvider (mounted ABOVE the
// route, in AppProviders) and immediately calls router.back(). That handoff
// only survives if /watch was entered in the SAME document — a plain
// <a href> unloads the calling document, so the provider that receives
// playTrack() belongs to the throwaway /watch document and is discarded by
// the cross-document back traversal. The user lands back on the track page
// with an empty queue, no MiniPlayerBar, and no error surface. The same
// full-page load also makes the /watch React unmount path unreal (nothing
// unmounts — the document is torn down), which the player lane depends on.
//
// How this is asserted: vitest resolves the bare specifier "next/link" to
// Next's PAGES build (next/link.js -> dist/client/link.js); the App Router
// build (dist/client/app-dir/link.js) is swapped in by the Next compiler at
// build time only, so the real component cannot be driven here. The stub
// below models exactly what the shipped Link does on an unmodified primary
// click — `e.preventDefault()` then a client-side router navigation
// (dist/client/link.js, `linkClicked`) — so the assertions land on the
// observable difference that the defect is made of: is the click swallowed
// into a client navigation, or does it fall through to the browser as a
// document navigation?

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const { PlayLink } = await import("./PlayLink.js");

const ITEM_ID = "01a0216a-4c55-72a3-a456-b161594125fc";

function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(event);
  return event;
}

describe("PlayLink", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    clientNav.pushes.length = 0;
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("starts a CLIENT-SIDE navigation to /watch/{itemId} instead of a full document load", () => {
    view = renderIntoBody(<PlayLink itemId={ITEM_ID} />);
    const anchor = view.container.querySelector("a");
    expect(anchor).not.toBeNull();

    const event = click(anchor as Element);

    // A raw <a href> leaves the click to the browser: the calling document
    // unloads, so /watch's playTrack() lands in a provider that the
    // router.back() traversal then throws away.
    expect(event.defaultPrevented).toBe(true);
    expect(clientNav.pushes).toEqual([`/watch/${ITEM_ID}`]);
  });

  it("keeps a real href so middle-click / open-in-new-tab / copy-link still work", () => {
    view = renderIntoBody(<PlayLink itemId={ITEM_ID} />);
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(`/watch/${ITEM_ID}`);
  });

  it("leaves a modified (cmd/ctrl) click to the browser", () => {
    view = renderIntoBody(<PlayLink itemId={ITEM_ID} />);
    const event = click(view.container.querySelector("a") as Element, { metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(clientNav.pushes).toEqual([]);
  });

  // Whole-surface guard for the same defect: EVERY /watch entry point has
  // to be client-side, not just this one. The two others the QA verifier
  // cited are components/detail/VersionRow.tsx (per-version rows) and
  // app/restricted/scenes/[id]/page.tsx (chapter markers); this catches any
  // new one too, including in files no component test covers.
  it("REGRESSION GUARD: no raw <a href> anywhere in apps/web points at /watch", () => {
    // fileURLToPath on the STRING form: under the jsdom environment the
    // global URL is jsdom's, and node:url rejects its instances.
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    // A plain `<a>` opening tag whose href targets /watch — `<Link href=…>`
    // (the correct form) and prose mentions of the pattern don't match.
    const rawWatchAnchor = /<a\b[^>]*href=\{?[`"]\/watch/;
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        if (rawWatchAnchor.test(readFileSync(full, "utf8"))) {
          offenders.push(full.slice(srcRoot.length + 1));
        }
      }
    };
    walk(srcRoot);

    expect(offenders).toEqual([]);
  });
});
