// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/next.config.mjs
//
// F2 (Wave-4 review, MED) + Phase 4 lane G1 deliverables 1/2: security
// headers applied to every route this Next app serves (headers() with
// source: "/(.*)"). Historical note (this wave CLOSES the gap the comment
// below used to describe): Content-Security-Policy USED TO be built and
// set statically right here, with `script-src 'unsafe-inline'` as a
// documented v1 tradeoff — Next 15's App Router injects dynamic, per-
// request inline `<script>` tags (the `self.__next_f` RSC-payload
// bootstrap) that a build-time-static CSP can never hash or nonce, and
// headers() here only runs once at build/start, not per request. That
// tradeoff is now CLOSED: CSP generation moved to src/proxy.ts (Next 16's
// rename of the middleware.ts convention — see proxy.ts's own header), which
// mints a fresh per-request nonce and uses `'nonce-...' 'strict-dynamic'`
// instead of `'unsafe-inline'` — see src/lib/csp.ts's header for the full
// design (nonce mechanism, LOOMBRE_SERVER_ORIGIN pairing, the blob:
// regression guard). This file now owns only the headers that genuinely
// ARE static (no per-request state needed) — CSP is proxy.ts's alone,
// never duplicated here (two different Content-Security-Policy header
// writers racing per-response would be a straightforward, silent bug).
//
// style-src 'unsafe-inline' (documented in csp.ts, still true): grepped
// for `style={{` across apps/web/src and found 13 files using inline style
// props (Card.tsx, ProgressBar.tsx, Overlay.tsx, NavRail.tsx, UserMenu.tsx,
// PosterCell.tsx, SearchPanel.tsx, VirtualPosterGrid.tsx, ResumePrompt.tsx,
// Scrubber.tsx, home/page.tsx, styleguide/page.tsx,
// MusicPlayerProvider.tsx) — CSP's style-src gates the style ATTRIBUTE the
// same as inline `<style>` blocks, and there is no nonce/hash mechanism for
// attributes the way there is for script/style tags.
//
// Permissions-Policy / Cross-Origin-Opener-Policy (task deliverable 2,
// "helmet-equivalent set ... on server AND web"): same minimal deny-list +
// same-origin posture as apps/server/src/main.ts's applySecurityHeaders —
// see that function's header for the full COOP/COEP evaluation (COEP is
// DELIBERATELY NOT applied here either, for the identical reason: it would
// require every cross-origin subresource — including media fetched from an
// operator's separate apps/server origin, P2.18 — to carry a matching
// CORP/CORS header, and this lane cannot verify that end-to-end in a real
// browser this wave; RESOURCE ISOLATION keeps the browser orchestrator-
// owned). Cross-Origin-Resource-Policy is NOT set here — that header only
// makes sense on RESPONSES BEING EMBEDDED cross-origin (apps/server's media
// bytes), not on this app's own HTML/JS, so it stays a server-side-only
// header.

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Source uses NodeNext-style ESM specifiers (`./foo.js` resolving to
  // `./foo.ts`/`./foo.tsx`) per tsconfig.base.json's moduleResolution —
  // webpack's default resolver doesn't apply that alias on its own.
  // Next 16 note: Turbopack (16's default bundler) has NO equivalent of
  // extensionAlias and fails module-not-found on every `.js`-suffixed
  // relative import (verified against 16.2.11 during the supported-latest
  // sweep), so build/dev pin --webpack; revisit if Turbopack grows
  // extensionAlias support or the repo migrates import style.
  // Installed deployments (all four installer channels) run the web app as
  // its own Node service from .next/standalone — a pruned server.js +
  // minimal real-dir node_modules — instead of shipping the 600 MB dev
  // deploy tree. Static export is NOT an option: the per-request CSP nonce
  // (src/proxy.ts) requires a live render path. Dev (`next dev`) ignores
  // this setting entirely.
  output: "standalone",

  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".tsx", ".ts", ".js"],
    };
    return config;
  },

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
