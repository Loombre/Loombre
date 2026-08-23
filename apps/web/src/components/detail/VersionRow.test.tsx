// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/VersionRow.test.tsx
//
// REGRESSION GUARD (77-agent review, "every per-version Play button starts
// the same DEFAULT file"): each row's <a href> must carry ITS OWN file.id
// as a `mediaFileId` query param, not just the shared itemId — otherwise
// two distinct version rows (e.g. Theatrical vs Director's Cut) render two
// visually distinct, individually-clickable Play affordances that both
// silently resolve to the item's default file. This is the FIRST half (the
// href); the receiving half — that the param actually reaches the session
// request — is guarded by app/watch/[itemId]/page.test.tsx (video) and
// components/music/MusicPlayerProvider.test.tsx (audio).
//
// The row is also a /watch ENTRY POINT, so it carries the same client-side
// navigation obligation as PlayLink (QA browser-items-F1) — see
// PlayLink.test.tsx's header for why a raw <a href> breaks the route, and
// for what the next/link stub below models.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

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
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        clientNav.pushes.push(href);
      }}
    >
      {children}
    </a>
  ),
}));

const { VersionRow } = await import("./VersionRow.js");

type MediaFileSummary = components["schemas"]["MediaFileSummary"];

function makeFile(overrides: Partial<MediaFileSummary> = {}): MediaFileSummary {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    versionLabel: null,
    container: "mkv",
    width: 1920,
    height: 1080,
    sizeBytes: 4_000_000_000,
    durationMs: 5_400_000,
    ...overrides,
  };
}

describe("VersionRow", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    clientNav.pushes.length = 0;
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("links to /watch/{itemId} with this row's own file.id as mediaFileId", () => {
    const file = makeFile({ id: "22222222-2222-2222-2222-222222222222" });
    view = renderIntoBody(<VersionRow itemId="99999999-9999-9999-9999-999999999999" file={file} />);
    const link = view.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "/watch/99999999-9999-9999-9999-999999999999?mediaFileId=22222222-2222-2222-2222-222222222222",
    );
  });

  it("REGRESSION GUARD: two version rows for the same item carry different hrefs, keyed off their own file.id", () => {
    const theatrical = makeFile({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", versionLabel: "Theatrical" });
    const directorsCut = makeFile({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", versionLabel: "Director's Cut" });
    const itemId = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    const first = renderIntoBody(<VersionRow itemId={itemId} file={theatrical} />);
    const firstHref = first.container.querySelector("a")?.getAttribute("href");
    first.unmount();

    const second = renderIntoBody(<VersionRow itemId={itemId} file={directorsCut} />);
    const secondHref = second.container.querySelector("a")?.getAttribute("href");
    second.unmount();

    expect(firstHref).toContain(theatrical.id);
    expect(secondHref).toContain(directorsCut.id);
    expect(firstHref).not.toBe(secondHref);
  });

  it("renders the version label and file metadata", () => {
    const file = makeFile({ versionLabel: "Director's Cut", height: 2160, container: "mkv" });
    view = renderIntoBody(<VersionRow itemId="99999999-9999-9999-9999-999999999999" file={file} />);
    expect(view.container.textContent).toContain("Director's Cut");
    expect(view.container.textContent).toContain("MKV");
  });

  it("falls back to 'Original' when versionLabel is null", () => {
    const file = makeFile({ versionLabel: null });
    view = renderIntoBody(<VersionRow itemId="99999999-9999-9999-9999-999999999999" file={file} />);
    expect(view.container.textContent).toContain("Original");
  });

  it("starts a CLIENT-SIDE navigation to /watch, not a full document load", () => {
    const itemId = "99999999-9999-9999-9999-999999999999";
    const file = makeFile({ id: "22222222-2222-2222-2222-222222222222" });
    view = renderIntoBody(<VersionRow itemId={itemId} file={file} />);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    view.container.querySelector("a")?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(clientNav.pushes).toEqual([`/watch/${itemId}?mediaFileId=${file.id}`]);
  });
});
