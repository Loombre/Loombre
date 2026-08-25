// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/brand/BootSplashLazy.tsx
//
// STATE.md "Blaze logo rollout" D9/G8 — single lazy-import wrapper shared
// by app/page.tsx (RootPage) and components/shell/AppShell.tsx: the app's
// two existing "blank frame while the boot decision resolves" mount points
// (previously `return null`), both routed through the SAME code-split
// import of BootSplash instead of two independently configured ones.
//
// G8 (budget exposure): AppShell is used by every authenticated route
// including /browse, which is under the 200 KB gz first-load-JS budget
// (scripts/perf-web-budget.mjs). The dynamic `import()` below keeps
// BootSplash's component code + its CSS module in their OWN chunk, fetched
// only when a mount point actually renders it (i.e. essentially never for
// a route reached by client-side navigation AFTER the tab's one real boot,
// since the D9 module flag makes every later render a no-op null) — not
// bundled into /browse's own page chunk statically.
//
// d3-s1 (P2, 2026-08-24 QA follow-up) — WHY THIS IS NOT `next/dynamic`
// ANY MORE. This wrapper used to be `dynamic(() => import("./BootSplash"),
// { ssr: false })`. In the App Router that is not "skip this component on
// the server": Next renders <BailoutToCSR> for it, which THROWS
// BailoutToCSRError (digest BAILOUT_TO_CLIENT_SIDE_RENDERING) during the
// server render. Because AppShell renders the splash from its very first
// render — authPhase starts "pending" — every authenticated document
// rendered that throw, so React switched the whole route subtree to
// client-side rendering:
//     curl -s /home | grep -c BAILOUT_TO_CLIENT_SIDE_RENDERING -> 1
//     <!--$!--><template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING">
// (/, /home, /browse, /settings/libraries; /login — the one route with no
// AppShell — was the only clean one.) Inside a bailed-out region NOTHING
// with an HTTP status survives: a next/navigation redirect()/notFound()
// ships as a flight-ERROR row that Next REPLAYS on the client, which is
// precisely what refuted round 1 of browser-admin-F1 (see next.config.mjs's
// redirects() header) and what forced those redirects up to the routing
// layer. The app also shipped zero server-rendered content.
//
// The replacement is plain React with the same two properties and none of
// the bailout: `lazy()` still produces a separate webpack chunk, and the
// `mounted` gate (set in an effect, i.e. client-only by construction) means
// the SERVER renders nothing at all and the client's first — hydrating —
// render renders nothing either, so hydration matches by construction
// instead of by Next stepping around it. The splash appears one effect
// later, exactly as it did when the chunk used to be fetched after mount.
// Pinned by BootSplashLazy.ssr.test.tsx (server: no bailout markers, empty
// markup, and a static import-graph guard that fails if ANY module on the
// AppShell/RootPage path reintroduces `ssr: false`) and
// BootSplashLazy.test.tsx (client: the splash still plays; hydrating an
// empty server slot logs no hydration error).

import { Suspense, lazy, useEffect, useState } from "react";

const BootSplashChunk = lazy(async () => {
  const mod = await import("./BootSplash.js");
  return { default: mod.BootSplash };
});

export function BootSplashLazy(): React.JSX.Element | null {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <Suspense fallback={null}>
      <BootSplashChunk />
    </Suspense>
  );
}
