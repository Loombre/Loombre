// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/history-entries.test.ts
//
// REGRESSION GUARD (d4-w8, backlog #122 — "app-wide, the FIRST client-side
// navigation after a full document load appears to REPLACE that document's
// history entry: Back afterwards skips the page the click happened on").
//
// ROOT CAUSE, MEASURED — 2026-08-25, live dev stack, a private headless
// Chromium driven over CDP with history.pushState/replaceState wrapped from
// before the app's first script (so every history write is attributed):
//
//   * /home (document load) -> click a sidebar link whose route `next dev`
//     has NOT compiled yet: the navigation commits ~3.6s later as
//     history.replaceState(<target>), from Next's HistoryUpdater — the
//     `else` branch of `pushRef.pendingPush && createHrefFromUrl(
//     location.href) !== canonicalUrl` in
//     next/dist/client/components/app-router.js. location was still /home
//     at that moment, so the second half of that test was true and
//     `pendingPush` was false: the push was already gone. history.length
//     unchanged, the /home entry overwritten, Back leaves the app. Exactly
//     the reported symptom.
//   * The SAME link, from the SAME page, once that route is compiled:
//     history.pushState, length +1, Back returns to /home.
//   * Latency is NOT the trigger. With 1.5s of added per-request latency a
//     warm route committed after 10.2s and still PUSHED — twice.
//
// So the trigger is `next dev`'s on-demand compilation of the destination
// route (in dev, Link prefetch — which would warm it — is off), not this
// app and not next/link. A production build has neither on-demand
// compilation nor an HMR channel, so the trigger is absent there; a
// `next build && next start` re-run is the one confirmation still owed,
// and it is a browser task, not one this suite can do.
//
// What CAN be guarded here is the half that is ours: this app must never
// write browser history itself, and its primary navigation surfaces must
// stay plain pushes. Either would reproduce the same "Back skips a page"
// through a mechanism we own. A direct history call is also worse than it
// looks: app-router.js patches BOTH methods and turns any non-Next call
// into an ACTION_RESTORE, whose state carries `pendingPush: false` — i.e.
// hand-writing history is itself a way to eat the next push.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      found.push(full);
    }
  };
  walk(SRC_ROOT);
  return found;
}

const relative = (file: string): string => file.slice(SRC_ROOT.length + 1);

describe("history entries — the app never eats one (d4-w8)", () => {
  it("no app code writes the browser history directly", () => {
    /** Direct history mutation, in any of its shapes. `location.assign` is
     *  deliberately NOT here: it keeps the entry it navigates from. */
    const writesHistory = /(?:^|[^\w.])(?:window\.)?history\.(?:pushState|replaceState)\s*\(|(?:^|[^\w.])location\.replace\s*\(|(?:^|[^\w.])location\.href\s*=[^=]/;

    /** Direct writes that are correct where they are, with the reason.
     *  EMPTY today, and a new entry needs a real one: Next patches both
     *  history methods and converts an app-made call into an ACTION_RESTORE
     *  (pendingPush: false), so "just this once" costs the next push. */
    const ALLOWED = new Map<string, string>();

    const offenders = sourceFiles()
      .filter((file) => writesHistory.test(readFileSync(file, "utf8")))
      .map(relative)
      .filter((file) => !ALLOWED.has(file));

    expect(offenders.sort()).toEqual([]);
  });

  it("the auth fallback pushes its own entry (location.assign, never location.replace)", () => {
    // lib/auth-return-path.ts's hardRedirect is the ONE deliberate full
    // document navigation in the app (AppShell's last resort when the
    // client router has stopped committing — browser-shell-browse-F1).
    // assign() leaves the page it came from in the history; replace()
    // would delete the very page the viewer is trying to get back to.
    const source = readFileSync(path.join(SRC_ROOT, "lib/auth-return-path.ts"), "utf8");
    expect(source).toMatch(/window\.location\.assign\(/);
    expect(source).not.toMatch(/location\.replace\(/);
  });

  it("the shell's primary navigation surfaces push (no <Link replace>)", () => {
    // The surfaces the QA repro used, and the ones every route reaches:
    // sidebar rows, the phone tab bar, the mobile header and the topbar.
    // The one deliberate <Link replace> in the app is
    // components/detail/PlayLink.tsx (audio targets only — QA gap-F8: the
    // /watch entry it would otherwise leave behind points at the detail
    // page the viewer is already on, so Back would be a dead press). It is
    // not a shell nav surface and is pinned by its own spec.
    const surfaces = ["components/shell/Sidebar.tsx", "components/shell/MobileTabBar.tsx", "components/shell/MobileHeader.tsx", "components/shell/Topbar.tsx", "components/shell/ShellNav.tsx"];
    const replacing = surfaces.filter((file) => /<Link\s[^>]*\breplace\b/.test(readFileSync(path.join(SRC_ROOT, file), "utf8")));

    expect(
      replacing,
      "a shell nav link that replaces makes Back skip the page it was clicked on — the exact symptom of backlog #122",
    ).toEqual([]);
  });
});
