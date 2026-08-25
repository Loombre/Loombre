// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/not-found.tsx
//
// Wave 1 (W1a) checkpoint assignment: Next's own default 404 renders
// WHITE (its built-in error boundary styling assumes a light page) inside
// what STATE.md's Phosphor retheme made a dark-only app (kickoff ground
// truth, STATE.md "Phosphor Open" — "No custom not-found page exists").
// This file is the special Next App Router convention that replaces that
// default for every unmatched route, tree-wide — no route wiring needed.
//
// Deliberately standalone, no AppShell: a 404 can be hit signed OUT (a
// stale/mistyped link) as easily as signed in, and AppShell's effect
// redirects an unauthenticated viewer to /login — wrong behavior for a
// page whose whole point is "this route doesn't exist," not "you're not
// allowed here." Root ("/") already carries the correct signed-in-vs-not
// boot-routing decision (decideBootRoute, app/page.tsx) so the recovery
// link below points there rather than guessing a destination itself.
//
// NO CSS IMPORT here, deliberately (browser-player-F13): the App Router
// preloads the root not-found boundary's CSS chunk in the head of EVERY
// route, but this boundary only renders on an actual 404 — the preload
// is never consumed, and Chromium re-warns about it after each
// resource-load burst (unbounded on /watch under the HLS fetch cadence).
// The styles live in globals.css under the `nf-` prefix instead (always
// loaded via the root layout, always consumed). Pinned by
// not-found.test.tsx.

import Link from "next/link";

export default function NotFound(): React.JSX.Element {
  return (
    <main className="nf-page">
      <div className="nf-content">
        <span className="nf-code">404</span>
        <h1 className="nf-title">Signal lost</h1>
        <p className="nf-message">This route doesn&apos;t exist on this server.</p>
        <Link href="/" className="nf-home-link">
          Back to Loombre
        </Link>
      </div>
    </main>
  );
}
