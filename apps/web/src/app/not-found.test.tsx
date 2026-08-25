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
// The fix is at the SOURCE: the root boundary must not contribute any CSS,
// so no boundary CSS chunk exists to preload. not-found.tsx's styles live
// in globals.css (imported by the root layout — always loaded, always
// consumed) under the `nf-` prefix. jsdom can't observe Next's head
// emission, so these tests pin the mechanism from both ends: (a) the
// boundary's MODULE GRAPH sources no CSS, and (b) every class it renders
// is defined in globals.css, so the 404 page did not silently lose its
// styling.
//
// d4-i2 WIDENING (backlog #090). The first version of (a) grepped
// not-found.tsx for a DIRECT `import … .css` line, which is only the first
// hop: a component not-found.tsx imports that itself pulls a
// `*.module.css` recreates the boundary chunk and the every-route preload
// with the guard still green (verified by construction — a two-hop probe
// passed all three of the original tests). Two more gaps of the same
// shape: the grep was hard-wired to `not-found.tsx`, so a future root
// `error.tsx` / `global-error.tsx` / `loading.tsx` / `template.tsx` — all
// of them boundaries Next bundles and preloads the same way — would have
// been born unguarded. So (a) is now a transitive walk of the first-party
// module graph rooted at EVERY root-level boundary convention that exists.
//
// BOUND worth knowing: the walk follows first-party specifiers only —
// relative (`./x.js`, `../y/z.js`) and the `@/*` alias. A bare package
// specifier (`next/link`, `@loombre/shared`) is recorded as unresolved and
// not walked, so a workspace package that shipped its own CSS through a
// barrel would still slip past. That is a deliberate stopping point: the
// graph under apps/web/src is the part this repo's boundaries actually
// grow into, and resolving pnpm's isolated `node_modules` here would buy a
// far larger, far flakier walk for a case no boundary has ever had.

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
const APP_ROOT = __dirname; // apps/web/src/app
const SRC_ROOT = path.resolve(__dirname, ".."); // apps/web/src
const notFoundSource = readFileSync(path.join(__dirname, "not-found.tsx"), "utf8");
const globalsCss = readFileSync(path.join(__dirname, "globals.css"), "utf8");

// ---------------------------------------------------------------------------
// The module-graph walk (a): every root App Router boundary convention, and
// everything it transitively imports, must contribute no CSS.
// ---------------------------------------------------------------------------

/**
 * Files Next treats as ROOT-level boundaries: rendered outside the normal
 * page tree, but their CSS is bundled into a chunk the router preloads in
 * the head of every route. `layout.tsx` is deliberately NOT here — it is
 * the one root file whose CSS is always rendered AND always consumed
 * (globals.css lives there on purpose).
 */
const ROOT_BOUNDARY_CONVENTIONS = [
  "not-found.tsx",
  "error.tsx",
  "global-error.tsx",
  "loading.tsx",
  "template.tsx",
] as const;

interface GraphScan {
  /** "<importer> imports <specifier>" for every CSS specifier reached. */
  readonly css: readonly string[];
  /** Absolute paths actually read — a walk that resolved nothing is a
   *  guard that can never fail, so tests assert on this too. */
  readonly visited: readonly string[];
  /** Bare package specifiers, recorded rather than walked (see the BOUND
   *  note in this file's header). */
  readonly unresolved: readonly string[];
}

/** Static imports, side-effect imports, re-exports and dynamic `import()`. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;'"]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s[^;'"]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * Resolves a FIRST-PARTY specifier to a file. Returns undefined for a bare
 * package specifier (not walked) and for a first-party specifier that
 * resolves to nothing on disk. TS source is written with `.js` specifiers
 * (NodeNext style) that resolve to `.tsx`/`.ts` on disk.
 */
function resolveFirstParty(
  specifier: string,
  importer: string,
  srcRoot: string,
  exists: (file: string) => boolean,
): string | undefined {
  let base: string;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.resolve(path.dirname(importer), specifier);
  } else if (specifier.startsWith("@/")) {
    base = path.join(srcRoot, specifier.slice(2));
  } else {
    return undefined;
  }
  const stem = base.replace(/\.js$/, "");
  const candidates = [
    base,
    `${stem}.tsx`,
    `${stem}.ts`,
    path.join(base, "index.tsx"),
    path.join(base, "index.ts"),
  ];
  return candidates.find((candidate) => exists(candidate));
}

function scanBoundaryGraph(input: {
  readonly entries: readonly string[];
  readonly srcRoot: string;
  readonly read: (file: string) => string | undefined;
  readonly exists: (file: string) => boolean;
}): GraphScan {
  const css: string[] = [];
  const visited: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const queue = [...input.entries];

  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = input.read(file);
    if (source === undefined) continue;
    visited.push(file);

    for (const specifier of importSpecifiers(source)) {
      if (specifier.endsWith(".css")) {
        css.push(`${path.relative(input.srcRoot, file)} imports ${specifier}`);
        continue;
      }
      const resolved = resolveFirstParty(specifier, file, input.srcRoot, input.exists);
      if (resolved === undefined) {
        unresolved.push(specifier);
        continue;
      }
      queue.push(resolved);
    }
  }

  return { css, visited, unresolved };
}

function scanFakeTree(tree: Record<string, string>, entries: string[]): GraphScan {
  return scanBoundaryGraph({
    entries,
    srcRoot: "/w/src",
    read: (file) => tree[file],
    exists: (file) => Object.hasOwn(tree, file),
  });
}

describe("the boundary-CSS walk itself catches what a direct-import grep cannot (d4-i2)", () => {
  // A guard whose walk silently resolved nothing would pass everything, so
  // the walk's own resolution is pinned here before it is trusted below.
  it("finds a CSS import TWO hops below the boundary", () => {
    const scan = scanFakeTree(
      {
        "/w/src/app/not-found.tsx": 'import { Deco } from "../components/Deco.js";',
        "/w/src/components/Deco.tsx": 'import { Ring } from "./Ring.js";',
        "/w/src/components/Ring.tsx": 'import "./ring.module.css";',
      },
      ["/w/src/app/not-found.tsx"],
    );
    expect(scan.css).toEqual(["components/Ring.tsx imports ./ring.module.css"]);
    expect(scan.visited).toHaveLength(3);
  });

  it("follows the `@/*` alias, `export … from`, dynamic import() and index files", () => {
    const scan = scanFakeTree(
      {
        "/w/src/app/error.tsx": 'export { Panel } from "@/components/panel/index.js";',
        "/w/src/components/panel/index.tsx": 'const Lazy = () => import("./Heavy.js");',
        "/w/src/components/panel/Heavy.tsx": 'import styles from "./heavy.module.css";',
      },
      ["/w/src/app/error.tsx"],
    );
    expect(scan.css).toEqual(["components/panel/Heavy.tsx imports ./heavy.module.css"]);
  });

  it("is quiet on a clean graph, and records bare package specifiers instead of walking them", () => {
    const scan = scanFakeTree(
      {
        "/w/src/app/not-found.tsx": 'import Link from "next/link";\nimport { A } from "./a.js";',
        "/w/src/app/a.tsx": 'import { format } from "@loombre/shared";',
      },
      ["/w/src/app/not-found.tsx"],
    );
    expect(scan.css).toEqual([]);
    expect(scan.unresolved).toEqual(["next/link", "@loombre/shared"]);
  });
});

describe("root boundary module graph contributes no CSS (browser-player-F13)", () => {
  const presentBoundaries = ROOT_BOUNDARY_CONVENTIONS.map((file) =>
    path.join(APP_ROOT, file),
  ).filter((file) => existsSync(file));

  it("not-found.tsx imports no CSS DIRECTLY — the first hop, kept as its own sharp message", () => {
    expect(notFoundSource).not.toMatch(/^\s*import\s[^\n]*\.css/m);
  });

  it("no root boundary contributes CSS anywhere in its transitive module graph", () => {
    // If this ever becomes empty the walk below is vacuous, so pin the entry.
    expect(presentBoundaries).toContain(path.join(APP_ROOT, "not-found.tsx"));

    const scan = scanBoundaryGraph({
      entries: presentBoundaries,
      srcRoot: SRC_ROOT,
      read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
      exists: existsSync,
    });

    expect(scan.visited).toEqual(expect.arrayContaining(presentBoundaries));
    expect(
      scan.css,
      "a root App Router boundary's module graph pulls CSS: Next will emit a boundary CSS " +
        "chunk and preload it in the head of EVERY route, where it is never consumed " +
        "(browser-player-F13). Move those styles into app/globals.css instead.",
    ).toEqual([]);
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
