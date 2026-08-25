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

/** Records what a real next/link click would hand to the client router —
 *  including WHICH history operation it would use (`replace` vs the default
 *  push), which is what verify/gap-F8 turns on. `vi.hoisted` so the
 *  (hoisted) vi.mock factory can close over it. */
const clientNav = vi.hoisted(() => ({ pushes: [] as string[], navigations: [] as Array<{ href: string; replace: boolean }> }));

/** The page the link is rendered on. */
const location = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => location.pathname,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    replace = false,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
    replace?: boolean;
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
        clientNav.navigations.push({ href, replace });
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
    clientNav.navigations.length = 0;
    location.pathname = "/";
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

  // QA verify/gap-F8 (P3): /watch's AUDIO branch hands the item to the
  // persistent music player and immediately router.replace()s to
  // /items/{track|album}/{id} — the very page this link is usually rendered
  // on. Pushing /watch first therefore leaves TWO adjacent history entries
  // for the SAME url (history.length 8 -> 9 in the repro), so the viewer's
  // next Back visibly does nothing. Video must keep the push: /watch STAYS
  // mounted there, and the player's own Back is a history traversal back to
  // the detail page.
  describe("history hygiene for the audio handoff (QA verify/gap-F8)", () => {
    it("REGRESSION GUARD: replaces instead of pushing when /watch will land back on this very page (track)", () => {
      location.pathname = `/items/track/${ITEM_ID}`;
      view = renderIntoBody(<PlayLink itemId={ITEM_ID} />);

      click(view.container.querySelector("a") as Element);

      expect(clientNav.navigations).toEqual([{ href: `/watch/${ITEM_ID}`, replace: true }]);
    });

    it("does the same on an album's own page", () => {
      location.pathname = `/items/album/${ITEM_ID}`;
      view = renderIntoBody(<PlayLink itemId={ITEM_ID} />);

      click(view.container.querySelector("a") as Element);

      expect(clientNav.navigations).toEqual([{ href: `/watch/${ITEM_ID}`, replace: true }]);
    });

    it("keeps the PUSH for video, so the player's Back still returns to the detail page", () => {
      location.pathname = `/items/movie/${ITEM_ID}`;
      view = renderIntoBody(<PlayLink itemId={ITEM_ID} />);

      click(view.container.querySelector("a") as Element);

      expect(clientNav.navigations).toEqual([{ href: `/watch/${ITEM_ID}`, replace: false }]);
    });

    it("keeps the PUSH on a restricted scene page (a movie, i.e. the video branch)", () => {
      location.pathname = `/restricted/scenes/${ITEM_ID}`;
      view = renderIntoBody(<PlayLink itemId={ITEM_ID} />);

      click(view.container.querySelector("a") as Element);

      expect(clientNav.navigations).toEqual([{ href: `/watch/${ITEM_ID}`, replace: false }]);
    });

    it("keeps the PUSH for a DIFFERENT item's audio page (the link is not the reason we're here)", () => {
      location.pathname = "/items/track/01a0216a-0000-0000-0000-000000000000";
      view = renderIntoBody(<PlayLink itemId={ITEM_ID} />);

      click(view.container.querySelector("a") as Element);

      expect(clientNav.navigations).toEqual([{ href: `/watch/${ITEM_ID}`, replace: false }]);
    });
  });

  // Whole-surface guard for the same defect: EVERY /watch entry point has
  // to be client-side, not just this one. The two others the QA verifier
  // cited are components/detail/VersionRow.tsx (per-version rows) and
  // app/restricted/scenes/[id]/page.tsx (chapter markers).
  //
  // d3-c3 widened WHAT counts as an offender. The original rule matched
  // `<a … href={`/watch…` — a LITERAL href only — so the two biggest
  // remaining /watch anchors were invisible to it:
  // SeriesDetailScreen.tsx's `<a href={primaryHref}>` (primaryHref =
  // `/watch/${resumeTarget.episodeId}`) and FeaturedBanner.tsx's
  // `<a href={candidate.playHref}>` (built in lib/featured-fields.ts).
  // Both were confirmed live as full document navigations. A regex cannot
  // follow a variable to its value, so the rule is now the house rule it
  // was always standing in for: in-app links are next/link, full stop —
  // any raw `<a href>` in apps/web/src is an offender unless it is in one
  // of the two tables below.
  it("REGRESSION GUARD: no raw <a href> anywhere in apps/web (any href form)", () => {
    /** Raw anchors that are CORRECT where they are, with the reason. */
    const ALLOWED = new Map<string, string>([
      [
        "components/browse/PosterCell.tsx",
        "raw <a> by design: its own onClick preventDefault()s and router.push()es inside a view transition — it already IS a client navigation; the href exists for middle-click/copy-link.",
      ],
      ["components/home/PosterCard.tsx", "same design as PosterCell.tsx: preventDefault() + runViewTransition(router.push(href))."],
      ["components/watchlist/WatchlistPosterCard.tsx", "same design as PosterCell.tsx: preventDefault() + runViewTransition(router.push(href))."],
      [
        "components/shell/SessionEndedNotice.tsx",
        "deliberate FULL document navigation: the always-available manual way out when the client router has stopped committing (lib/auth-return-path.ts).",
      ],
      [
        "components/admin/system/LogsTailCard.tsx",
        "external link (docs site) with target=_blank rel=noreferrer — next/link is for in-app routes.",
      ],
      ["components/admin/system/UpdateNoticeCard.tsx", "external link (release notes URL) with target=_blank rel=noreferrer."],
      ["components/settings/remote-wizard/RemoteEnableStepBody.tsx", "external link (wireguard.com/install) with target=_blank rel=noreferrer."],
    ]);

    /** Same defect, files outside this lane's ownership — tracked, not
     *  skipped, so the guard still catches every NEW offender and this list
     *  stays the follow-up's exact worklist. Remove an entry when it is
     *  converted to next/link. */
    const KNOWN_REMAINING = new Map<string, string>([
      ["app/items/[itemType]/[id]/DetailScreens.tsx", "C/detail-back-links-raw-anchor: the episode/track 'back to …' links."],
      ["components/detail/EpisodeRow.tsx", "C/detail-back-links-raw-anchor: every episode row on a series detail."],
      ["components/detail/SceneBanner.tsx", "C/detail-back-links-raw-anchor: the '← LIBRARY' back pill."],
      ["components/music/AlbumDetailScreen.tsx", "C/detail-back-links-raw-anchor: the more-albums tiles and the artist links."],
      ["components/browse/SearchMovieRow.tsx", "C/zone-search-result-raw-anchor: search overlay results."],
      ["components/browse/SearchMusicGrid.tsx", "C/zone-search-result-raw-anchor: search overlay results."],
    ]);

    // fileURLToPath on the STRING form: under the jsdom environment the
    // global URL is jsdom's, and node:url rejects its instances.
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    // A plain `<a>` opening tag carrying an href, in ANY form: a literal, a
    // template literal, or `{anyExpression}`. `<Link href=…>` (the correct
    // form) and prose mentions of the pattern don't match.
    const rawAnchorWithHref = /<a\s[^>]*href=/;
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        if (rawAnchorWithHref.test(readFileSync(full, "utf8"))) {
          offenders.push(full.slice(srcRoot.length + 1));
        }
      }
    };
    walk(srcRoot);

    expect(offenders.filter((f) => !ALLOWED.has(f) && !KNOWN_REMAINING.has(f)).sort()).toEqual([]);
  });
});
