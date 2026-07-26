// SPDX-License-Identifier: AGPL-3.0-only
import { headers } from "next/headers";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppProviders } from "../components/providers/AppProviders.js";
import "./globals.css";

// Blaze logo rollout W0 (STATE.md, D7 as amended by G1): apps/web served NO
// favicon/manifest before this — there was nothing to "replace" (D7's own
// wording), this wiring is new. SVG ships as the primary favicon (modern
// browsers render it directly, incl. at non-integer device pixel ratios);
// the three PNG sizes are fallbacks for browsers with no
// type="image/svg+xml" favicon support. Apple touch icon reuses the dark
// 1024 app icon directly (no separate export needed — see app/manifest.ts
// for the same icon's "any"/"maskable" manifest entries). A grep across the
// build output proves no former favicon/pulse-dot asset survives (Lane D).
export const metadata: Metadata = {
  title: "Loombre",
  description: "Loombre — self-hosted media streaming platform",
  icons: {
    icon: [
      { url: "/loombre-favicon.svg", type: "image/svg+xml" },
      { url: "/loombre-favicon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/loombre-favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/loombre-favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/loombre-app-icon-dark-1024.png", sizes: "1024x1024", type: "image/png" }],
  },
};

// Wave 1 (W1a) responsive breakpoint: viewportFit "cover" is what makes
// env(safe-area-inset-*) resolve to real (non-zero) values on notched
// devices instead of silently being 0 everywhere — required for the new
// MobileTabBar/MobileHeader/MiniPlayerBar mobile insets to do anything on
// an actual iPhone. No previous viewport export existed (Next's own
// default has no viewport-fit, i.e. safe-area was always 0 before this).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Dark-only (STATE.md "Phosphor retheme + responsive rebuild" — README
// "Light theme — removed"): this file used to apply a persisted
// [data-theme="light"] attribute before first paint via a hand-authored
// inline <script>, which is why RootLayout used to be async (reading the
// proxy.ts-minted nonce via next/headers to stamp that one script). There
// is exactly one theme now — nothing to flash-prevent, nothing to nonce by
// hand — so that ORIGINAL reason for calling headers() is gone.
//
// CRITICAL (Phosphor W3 fidelity-audit finding, pre-existing since Phase 4
// G1/b9f4d16 — restored here as PART OF the same fix, not a new one): the
// paragraph this replaces used to claim proxy.ts's response header alone
// was enough for "Next's own strict-dynamic mechanism" — that claim was
// simply WRONG, and is the other half of the CRITICAL bug this fix wave
// closes (see proxy.ts's header + csp.test.ts). Next reads the
// request's live per-request nonce
// (app-render.js's parseRequestHeaders -> getScriptNonceFromHeader) ONLY
// while it is actually RE-RENDERING the route for THIS request. A
// route Next has classified as static is pre-rendered ONCE at `next
// build` time (no request exists yet — no nonce to read) and then served
// byte-identical from the Full Route Cache forever after; proxy.ts
// rewriting request/response headers on the way in/out of that cached
// response changes nothing about the frozen HTML bytes already sitting in
// the cache. `headers()` is a Dynamic API — calling it here is what tells
// Next this entire tree cannot be statically prerendered, forcing every
// route to actually re-run app-render.js (and therefore read a FRESH
// nonce off the request) on every hit. This is Next's own documented CSP
// pattern (https://nextjs.org/docs — "Content Security Policy": the root
// layout reads the nonce via headers()) — the call's return value has no
// consumer of its own today (no hand-authored inline <script> needs an
// explicit nonce prop, per this file's dark-only-theme paragraph above);
// the CALL ITSELF, not its result, is the fix. Stamped onto <html> as a
// debug-visible attribute so a real value isn't simply discarded. Proof:
// this lane's freeze report — `next build`'s route table shift (○ ->
// ƒ) plus a `next start` curl showing real nonce="..." attributes on
// every <script> tag.
export default async function RootLayout({ children }: { children: ReactNode }): Promise<React.JSX.Element> {
  const nonce = (await headers()).get("x-nonce");
  return (
    <html lang="en" data-csp-nonce={nonce ?? undefined}>
      <head>
        {/* U6: self-hosted Phosphor type, preloaded for the two primary
            faces — the Archivo variable file (every heading + the
            font-stretch-125% wordmark) and IBM Plex Mono 400 (every mono
            label/count/path in the app, i.e. almost every screen). The
            remaining Plex Mono weights (500/600) and both latin-ext
            subsets load on demand via the @font-face rules in
            src/styles/fonts.css — same-origin, no runtime font CDN. */}
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/archivo/archivo-variable-latin.woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/ibm-plex-mono/ibm-plex-mono-400-latin.woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        {/* AppProviders (Wave-2 lane ii, P2.5/P2.8) sits above the
            per-route layout remount boundary on purpose — see that
            component's header. Everything else in this file is unchanged. */}
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
