// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/app/not-found.test.tsx
//
// browser-player-F13: the App Router emits a
// `<link rel="preload" as="style">` for the ROOT not-found boundary's CSS
// chunk in the head of EVERY route, but the boundary only renders on an
// actual 404 — the preload is never consumed, and Chromium re-warns about
// the unused preload after each resource-load burst. On /watch the HLS
// cadence (media playlist every ~3s, a segment every ~6s) makes that
// unbounded: 46 not-found.css warnings in ~8 minutes of steady playback
// (independent re-verify, 2026-08-24; 111/15min in the original lane run).
// Confirmed in a production build too (hashed chunk containing only the
// .not-found_* classes) — this is not dev-only noise.
//
// The fix is at the SOURCE: not-found.tsx must not import any CSS, so no
// boundary CSS chunk exists to preload. Its styles live in globals.css
// (imported by the root layout — always loaded, always consumed) under
// the `nf-` prefix. jsdom can't observe Next's head emission, so these
// tests pin the mechanism from both ends: (a) the component sources no
// CSS of its own, and (b) every class it renders is defined in
// globals.css, so the 404 page did not silently lose its styling.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../components/ui/test-render.js";
import NotFound from "./not-found.js";

// Same stub shape as PlayLink.test.tsx: the real App Router <Link> cannot
// mount outside the Next runtime; the anchor is all this test needs.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const notFoundSource = readFileSync(path.join(__dirname, "not-found.tsx"), "utf8");
const globalsCss = readFileSync(path.join(__dirname, "globals.css"), "utf8");

describe("root not-found boundary emits no CSS chunk (browser-player-F13)", () => {
  it("not-found.tsx imports no CSS — any CSS import becomes a boundary chunk preloaded-but-unused on every route", () => {
    expect(notFoundSource).not.toMatch(/^\s*import\s[^\n]*\.css/m);
  });

  it("not-found.module.css is gone (folded into globals.css), so Next cannot rebuild the chunk from it", () => {
    expect(existsSync(path.join(__dirname, "not-found.module.css"))).toBe(false);
  });
});

describe("the 404 page kept its styling (classes now live in globals.css)", () => {
  let view: TestRender | undefined;
  afterEach(() => {
    view?.unmount();
    view = undefined;
  });

  it("every class NotFound renders resolves to a globals.css rule", () => {
    view = renderIntoBody(<NotFound />);
    const classes = Array.from(view.container.querySelectorAll("[class]")).flatMap((el) =>
      Array.from(el.classList)
    );
    // The page styles four-plus elements (page/content/code/title/message/link);
    // an empty list would mean the styling was dropped, not moved.
    expect(new Set(classes).size).toBeGreaterThanOrEqual(4);
    for (const cls of new Set(classes)) {
      expect(
        globalsCss.includes(`.${cls}`),
        `class "${cls}" rendered by not-found.tsx has no rule in globals.css`
      ).toBe(true);
    }
  });
});
