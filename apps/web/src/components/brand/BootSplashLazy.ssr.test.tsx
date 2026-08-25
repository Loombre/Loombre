// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Loombre :: apps/web/src/components/brand/BootSplashLazy.ssr.test.tsx
//
// d3-s1 (P2, 2026-08-24 QA follow-up) — RED-first pin for the app-wide CSR
// bailout. AppShell (every authenticated route) and RootPage (`/`) both
// render <BootSplashLazy/> from their FIRST render, i.e. inside the server
// render of the document. While that wrapper was
// `next/dynamic(..., { ssr: false })`, Next's App Router implementation
// (next/dist/shared/lib/lazy-dynamic/loadable -> dynamic-bailout-to-csr)
// THREW `BailoutToCSRError` (digest BAILOUT_TO_CLIENT_SIDE_RENDERING) on
// every server render, so the whole route subtree degraded to client-side
// rendering:
//
//   $ curl -s http://127.0.0.1:$PORT/home | grep -c BAILOUT   -> 1
//     <template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING"></template>
//   (/, /home, /browse, /settings/libraries all 1; /login — the one route
//    with no AppShell — 0.)
//
// The consequence is not cosmetic: inside a bailed-out region a
// next/navigation redirect()/notFound() ships as a flight-ERROR row that
// Next REPLAYS client-side (this is exactly what refuted round 1 of
// browser-admin-F1 — see next.config.mjs's redirects() header), and no
// status-code-bearing server behaviour survives.
//
// WHY THE next/dynamic MOCK: vitest resolves the bare `next/dynamic`
// specifier to the PAGES-router copy (next/dist/shared/lib/dynamic), whose
// ssr:false path renders the loading component on the server and never
// throws. Next's own bundler aliases `next/dynamic` to
// `next/dist/shared/lib/app-dynamic` for everything under app/ — that is
// the implementation this app actually ships, and the only one that can
// reproduce the bailout. The mock therefore makes the test honest, not
// lenient: it is what the built app does.
//
// The second test is the durable guard — a static walk of the import graph
// hanging off AppShell and RootPage asserting that NOTHING on the document
// render path opts out of SSR again (a `ssr: false` anywhere on that path
// re-breaks every route at once, which is what makes this a P2).

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/dynamic", async () => {
  const mod = (await import("next/dist/shared/lib/app-dynamic.js")) as unknown as {
    default: unknown;
  };
  return { default: mod.default ?? mod };
});

const { BootSplashLazy } = await import("./BootSplashLazy.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, "../..");

// React does not RETHROW a bailout: the erroring Suspense boundary is
// serialized as "switched to client rendering" markup — `<!--$!-->` plus a
// <template> carrying the reason (data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING"
// in a production build, data-msg="…Bail out to client-side rendering…" in
// development). That markup is exactly what `curl /home` returned before
// this fix, so the assertions below key on it rather than on a throw.
const BAILOUT_MARKERS = [
  "BAILOUT_TO_CLIENT_SIDE_RENDERING",
  "Bail out to client-side rendering",
  // React's marker for a Suspense boundary that errored during SSR.
  "<!--$!-->",
];

/** Crude but sufficient: block comments and whole-line `//` comments. The
 *  point is that this file's own prose (and BootSplashLazy's header, which
 *  documents the `ssr: false` history it replaced) must not read as a
 *  violation of the rule it describes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Resolves a NodeNext-style relative specifier (`./x.js` -> x.tsx/x.ts)
 *  the same way next.config.mjs's webpack `extensionAlias` does. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = base.endsWith(".js")
    ? [base.replace(/\.js$/, ".tsx"), base.replace(/\.js$/, ".ts"), base]
    : [`${base}.tsx`, `${base}.ts`, base, join(base, "index.tsx"), join(base, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every module reachable by STATIC relative imports from `roots` — i.e.
 *  exactly the set of files whose module scope participates in the server
 *  render of a document. */
function staticImportGraph(roots: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = stripComments(readFileSync(file, "utf8"));
    const specifiers = [
      ...source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*["'](\.[^"']+)["']/g),
      ...source.matchAll(/(?:^|\n)\s*import\s+["'](\.[^"']+)["']/g),
    ].map((match) => match[1]!);
    for (const specifier of specifiers) {
      if (specifier.endsWith(".css")) continue;
      const target = resolveRelative(file, specifier);
      if (target && !target.includes(".test.")) queue.push(target);
    }
  }
  return [...seen];
}

describe("BootSplashLazy — document render path (d3-s1)", () => {
  it("runs in a server-shaped environment (the bailout only fires without `window`)", () => {
    expect(typeof window).toBe("undefined");
  });

  it("server-renders without a CSR bailout", () => {
    const markup = renderToString(<BootSplashLazy />);
    for (const marker of BAILOUT_MARKERS) {
      expect(markup, `server render bailed out to CSR (${marker})`).not.toContain(marker);
    }
    // Nothing on the server: the splash is a post-hydration animation, and
    // an empty server render is what the client's first render must match
    // (see BootSplashLazy.test.tsx for the hydration half).
    expect(renderToStaticMarkup(<BootSplashLazy />)).toBe("");
  });

  it("no module on the AppShell / root-page render path opts out of SSR", () => {
    const roots = [join(WEB_SRC, "components/shell/AppShell.tsx"), join(WEB_SRC, "app/page.tsx")];
    for (const root of roots) expect(existsSync(root), `${root} must exist`).toBe(true);

    const graph = staticImportGraph(roots);
    expect(graph.length).toBeGreaterThan(10);
    const offenders = graph
      .filter((file) => /ssr\s*:\s*false/.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => file.slice(WEB_SRC.length + 1));
    expect(
      offenders,
      "an `ssr: false` dynamic import on the document render path bails EVERY route out to CSR",
    ).toEqual([]);
  });
});
