// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/apply-match-provider.spec.ts
//
// api-validation-F11, the fast half: the pure name parse, plus the one
// property that keeps this check cheap on the request path — a name that
// isn't a plugin ref is rejected WITHOUT any DB round trip (proven with a
// db stub that throws if it is ever touched, not by inference). The
// exists/enabled half needs real plugin rows and is covered live in
// apps/server/test/admin-fix-match.e2e.spec.ts.

import { describe, expect, it } from "vitest";
import type { HttpException } from "@nestjs/common";
import type { LoombreDb } from "../common/db.provider.js";
import { parseApplyMatchProvider, requireResolvableApplyMatchProvider } from "./apply-match-provider.js";

/** Any property access is a test failure — this db must never be used. */
const explodingDb = new Proxy(
  {},
  {
    get() {
      throw new Error("apply-match provider validation touched the DB for a non-plugin provider name");
    },
  },
) as unknown as LoombreDb;

const INSTANCE = "/admin/items/01a01f7a-36d5-7e7c-9e30-c85c082a5de9/apply-match";

/** The thrown ProblemException, or a failure if the call resolved. */
async function rejection(provider: string): Promise<HttpException> {
  try {
    await requireResolvableApplyMatchProvider(explodingDb, provider, INSTANCE);
  } catch (err) {
    return err as HttpException;
  }
  throw new Error(`expected provider ${JSON.stringify(provider)} to be rejected`);
}

describe("parseApplyMatchProvider", () => {
  it.each(["tmdb", "tvdb", "musicbrainz", "stash"])("recognizes the built-in %j", (name) => {
    expect(parseApplyMatchProvider(name)).toEqual({ kind: "builtin", name });
  });

  it("recognizes a well-formed lpp:<pluginId>", () => {
    expect(parseApplyMatchProvider("lpp:018f6f1e-0000-7000-8000-0000000005c1")).toEqual({
      kind: "plugin",
      pluginId: "018f6f1e-0000-7000-8000-0000000005c1",
    });
  });

  // The registry's lookup is a case-sensitive Map.get, so ours is too —
  // "TMDB" really is a miss there, and pretending otherwise here would
  // hand back a 202 for a job that still no-ops.
  it.each(["TMDB", "Tmdb", "tmdb ", " tmdb", "tmdb\n"])("rejects the near-miss %j", (name) => {
    expect(parseApplyMatchProvider(name)).toEqual({ kind: "unknown" });
  });

  // A non-UUID id must never reach the `plugins.id uuid` column.
  it.each(["lpp:", "lpp:not-a-uuid", "lpp:../../etc/passwd", "lpp:018f6f1e-0000-7000-8000", "lpp"])(
    "rejects the malformed plugin ref %j without claiming it is a plugin",
    (name) => {
      expect(parseApplyMatchProvider(name)).toEqual({ kind: "unknown" });
    },
  );

  it.each(["", "bogus-provider", "urn:tmdb", "lpp::018f6f1e-0000-7000-8000-0000000005c1"])("rejects %j", (name) => {
    expect(parseApplyMatchProvider(name)).toEqual({ kind: "unknown" });
  });
});

describe("requireResolvableApplyMatchProvider", () => {
  it.each(["tmdb", "tvdb", "musicbrainz", "stash"])("accepts the built-in %j with no DB read", async (name) => {
    await expect(requireResolvableApplyMatchProvider(explodingDb, name, INSTANCE)).resolves.toBeUndefined();
  });

  it("rejects an unknown name with a 422 naming the field, still with no DB read", async () => {
    const err = await rejection("bogus-provider");
    expect(err.getStatus()).toBe(422);
    const body = err.getResponse() as { type: string; detail: string; instance: string };
    expect(body.type).toBe("urn:loombre:problem:validation");
    expect(body.instance).toBe(INSTANCE);
    expect(body.detail).toContain("provider");
    expect(body.detail).toContain('"bogus-provider"');
    expect(body.detail).toContain("tmdb");
    expect(body.detail).toContain("lpp:<pluginId>");
  });

  // The echoed value is bounded — an oversized field must not ride back
  // out whole in the problem body.
  it("truncates an oversized provider value in the detail", async () => {
    const err = await rejection("x".repeat(5_000));
    const { detail } = err.getResponse() as { detail: string };
    expect(detail.length).toBeLessThan(400);
    expect(detail).toContain("…");
  });
});
