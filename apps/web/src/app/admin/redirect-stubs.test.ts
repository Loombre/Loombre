// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/admin/redirect-stubs.test.ts
//
// browser-admin-F1 (P1, ROUND 2) regression pin for every legacy /admin/*
// redirect route. These redirects exist for one reason: an old bookmark to
// /admin/<thing> must still land on its /settings/... replacement.
//
// Round 1 made each stub page a server component calling next/navigation
// redirect(), and this file asserted the NEXT_REDIRECT digest each module
// threw. The verifier REFUTED that fix on the live stack: AppShell
// statically imports BootSplashLazy (next/dynamic ssr:false), so every
// admin document render hits BAILOUT_TO_CLIENT_SIDE_RENDERING and the
// redirect() digest ships as a flight-ERROR row that Next replays
// CLIENT-side (RedirectBoundary's effect) inside admin/layout.tsx's
// deferred {children} — the exact late mount that ate the original
// useEffect router.replace. Hard loads stuck 14/17 trials; the document
// response was HTTP 200, never the claimed 307.
//
// Round 2 therefore moves the redirect to a layer React CANNOT defer:
// `redirects()` in apps/web/next.config.mjs. Those are resolved by the
// Next server's routing layer BEFORE any filesystem route or render is
// consulted — the document request itself gets a real HTTP 307 +
// Location, and client-side navigations get the same redirect on their
// RSC fetch. No component tree, layout guard, or CSR bailout is in the
// path. The six stub page files are DELETED: with the config redirect
// matching first they were unreachable dead code, and their absence
// removes the admin-shell-swallows-the-nav surface entirely.
//
// What a unit test CAN honestly pin is the map itself — that is what this
// file asserts (import the config, inspect the redirects() array). What
// it CANNOT see is the running server actually honoring the map on a
// hard load; that end-to-end check (curl -sI => 307 + Location, browser
// hard loads landing with the URL changed) is the live-stack re-verify
// agent's job, recorded in the remediation ledger.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import nextConfig from "../../../next.config.mjs";

// jsdom's global URL rejects `new URL(rel, import.meta.url)` ("The URL
// must be of scheme file") — take the string form and join from there.
const HERE = dirname(fileURLToPath(import.meta.url));

interface RedirectEntry {
  source: string;
  destination: string;
  permanent?: boolean;
  statusCode?: number;
}

/** Every legacy /admin/* route and its documented replacement. */
const LEGACY: Array<{ source: string; destination: string; deletedStub: string }> = [
  { source: "/admin/libraries", destination: "/settings/libraries", deletedStub: "libraries/page.tsx" },
  { source: "/admin/users", destination: "/settings/users", deletedStub: "users/page.tsx" },
  { source: "/admin/settings", destination: "/settings/advanced", deletedStub: "settings/page.tsx" },
  { source: "/admin/system", destination: "/admin", deletedStub: "system/page.tsx" },
  { source: "/admin/plugins", destination: "/settings/plugins", deletedStub: "plugins/page.tsx" },
  // path-to-regexp `:id` — preserves the (already percent-encoded) id
  // segment verbatim on the HTTP layer; a slash inside an id is a
  // different path by definition, so no encodeURIComponent is involved.
  { source: "/admin/plugins/:id", destination: "/settings/plugins/:id", deletedStub: "plugins/[id]/page.tsx" },
];

async function loadRedirects(): Promise<RedirectEntry[]> {
  const fn = (nextConfig as { redirects?: () => Promise<RedirectEntry[]> }).redirects;
  expect(fn, "next.config.mjs must define redirects()").toBeTypeOf("function");
  const entries = await fn!();
  expect(Array.isArray(entries)).toBe(true);
  return entries;
}

describe("legacy /admin/* HTTP redirects (browser-admin-F1 round 2)", () => {
  it.each(LEGACY)("$source is redirected to $destination by next.config, status 307", async (legacy) => {
    const entries = await loadRedirects();
    const matches = entries.filter((e) => e.source === legacy.source);
    expect(matches, `exactly one redirects() entry for ${legacy.source}`).toHaveLength(1);
    const entry = matches[0]!;
    expect(entry.destination).toBe(legacy.destination);
    // permanent: false => Next serves 307 (Temporary Redirect). Never a
    // cacheable 308 for these, and no statusCode override sneaking in a
    // 301/302 that could downgrade the method.
    expect(entry.permanent).toBe(false);
    expect(entry.statusCode).toBeUndefined();
  });

  it("covers ONLY the six legacy routes — live /admin pages stay reachable", async () => {
    const entries = await loadRedirects();
    const adminSources = entries.map((e) => e.source).filter((s) => s === "/admin" || s.startsWith("/admin/"));
    // An over-broad pattern (e.g. "/admin/:path*") would also swallow the
    // real /admin dashboard, /admin/jobs and /admin/sessions.
    expect(adminSources.sort()).toEqual(LEGACY.map((l) => l.source).sort());
  });

  it.each(LEGACY)("the $source stub page file stays deleted", (legacy) => {
    // With the config redirect matching first, a page file at the legacy
    // route is unreachable dead code — and round 1 proved a page-level
    // redirect can be silently deferred by the CSR bailout. Keep the
    // filesystem route gone.
    expect(
      existsSync(join(HERE, legacy.deletedStub)),
      `${legacy.deletedStub} must not exist — the redirect lives in next.config.mjs`,
    ).toBe(false);
  });
});
