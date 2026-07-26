// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/brand/BootSplashLazy.ts
//
// STATE.md "Blaze logo rollout" D9/G8 — single dynamic-import wrapper
// shared by app/page.tsx (RootPage) and components/shell/AppShell.tsx: the
// app's two existing "blank frame while the boot decision resolves" mount
// points (previously `return null`), now both routed through the SAME
// `next/dynamic(..., { ssr: false })` call instead of two independently
// configured ones.
//
// G8 (budget exposure): AppShell is used by every authenticated route
// including /browse, which is under the 200 KB gz first-load-JS budget
// (scripts/perf-web-budget.mjs). Dynamic import keeps BootSplash's
// component code + its CSS module in their OWN chunk, fetched only when a
// mount point actually renders it (i.e. essentially never for a route
// reached by client-side navigation AFTER the tab's one real boot, since
// the D9 module flag makes every later render a no-op null) — not
// bundled into /browse's own page chunk statically. Verified against
// `next build --webpack`'s output; see the Lane B freeze report for the
// exact before/after chunk list.
import dynamic from "next/dynamic";

export const BootSplashLazy = dynamic(() => import("./BootSplash.js").then((mod) => mod.BootSplash), {
  ssr: false,
});
