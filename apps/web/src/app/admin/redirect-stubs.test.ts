// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/admin/redirect-stubs.test.ts
//
// browser-admin-F1 (P1) regression pin for EVERY /admin/* redirect-only
// stub. These routes exist for one reason: an old bookmark to
// /admin/<thing> must still land on its /settings/... replacement. They
// used to do that from a client `useEffect(() => router.replace(...))`,
// which the QA run caught silently dropping 6 of 7 hard loads: the stub
// mounts as a DEFERRED child of app/admin/layout.tsx (that layout renders
// {children} only after useAdminGuard's async GET /users/me flips
// `isAdmin` to true), and a replace() fired from that late mount fetched
// the target's RSC payload but never committed the navigation — the user
// sat on an empty admin shell.
//
// The fix is structural, so the check is structural: the redirect must be
// issued by the SERVER render of the page (next/navigation `redirect()`,
// which throws a NEXT_REDIRECT digest the framework turns into a real
// 307), never by an effect that only runs if and when the component
// mounts. So each stub is asserted twice — it must not be a client
// component wired to useRouter/useEffect, and calling its default export
// must redirect to the documented target.
//
// Supersedes the two per-route client-router pins this replaced
// (plugins/page.test.tsx + plugins/[id]/page.test.tsx from LD-8): both
// asserted the router.replace shape that is exactly the defect.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// jsdom's global URL rejects `new URL(rel, import.meta.url)` ("The URL
// must be of scheme file") — take the string form and join from there.
const HERE = dirname(fileURLToPath(import.meta.url));

/** Drop comments so the header prose describing the OLD defect (which
 * necessarily names useEffect/router.replace) can't satisfy the code
 * assertions below. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

interface RedirectInfo {
  url: string;
  type: string;
  status: number;
}

/** Decode next/navigation's `NEXT_REDIRECT;<type>;<url>;<status>;` digest. */
function parseRedirect(err: unknown): RedirectInfo | null {
  const digest: unknown = (err as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT;")) return null;
  const parts = digest.split(";");
  return {
    type: parts[1] ?? "",
    url: parts.slice(2, -2).join(";"),
    status: Number(parts[parts.length - 2]),
  };
}

async function redirectFrom(run: () => unknown): Promise<RedirectInfo> {
  let returned: unknown;
  try {
    returned = await run();
  } catch (err) {
    const info = parseRedirect(err);
    if (info) return info;
    throw new Error(`expected a server-side NEXT_REDIRECT, got a different throw: ${String(err)}`, {
      cause: err,
    });
  }
  throw new Error(
    `expected a server-side NEXT_REDIRECT, but the page returned ${String(returned)} without redirecting`,
  );
}

interface Stub {
  route: string;
  file: string;
  load: () => Promise<{ default: (props: never) => unknown }>;
  target: string;
}

const STUBS: Stub[] = [
  {
    route: "/admin/libraries",
    file: "libraries/page.tsx",
    load: () => import("./libraries/page.js"),
    target: "/settings/libraries",
  },
  {
    route: "/admin/users",
    file: "users/page.tsx",
    load: () => import("./users/page.js"),
    target: "/settings/users",
  },
  {
    route: "/admin/settings",
    file: "settings/page.tsx",
    load: () => import("./settings/page.js"),
    target: "/settings/advanced",
  },
  {
    route: "/admin/system",
    file: "system/page.tsx",
    load: () => import("./system/page.js"),
    target: "/admin",
  },
  {
    route: "/admin/plugins",
    file: "plugins/page.tsx",
    load: () => import("./plugins/page.js"),
    target: "/settings/plugins",
  },
  {
    route: "/admin/plugins/[id]",
    file: "plugins/[id]/page.tsx",
    load: () => import("./plugins/[id]/page.js"),
    target: "/settings/plugins/abc-123",
  },
];

describe("/admin/* redirect stubs (browser-admin-F1)", () => {
  it.each(STUBS)("$route redirects server-side, not from an effect", async (stub) => {
    const source = stripComments(readFileSync(join(HERE, stub.file), "utf8"));

    // A stub that needs to MOUNT to redirect is the defect: under
    // app/admin/layout.tsx's deferred children the mount is late and the
    // replace() is dropped.
    expect(source, `${stub.file} must not be a client component`).not.toMatch(/^\s*["']use client["'];?\s*$/m);
    expect(source, `${stub.file} must not redirect from a hook/effect`).not.toMatch(/\buseRouter\b|\buseEffect\b/);

    const mod = await stub.load();
    const props = stub.route.endsWith("[id]")
      ? ({ params: Promise.resolve({ id: "abc-123" }) } as never)
      : (undefined as never);

    const info = await redirectFrom(() => mod.default(props));
    expect(info.url).toBe(stub.target);
    expect(info.status).toBe(307);
  });

  it("percent-encodes the preserved plugin id segment", async () => {
    const mod = await import("./plugins/[id]/page.js");
    const info = await redirectFrom(() =>
      (mod.default as (p: never) => unknown)({ params: Promise.resolve({ id: "a b/c" }) } as never),
    );
    expect(info.url).toBe("/settings/plugins/a%20b%2Fc");
  });
});
