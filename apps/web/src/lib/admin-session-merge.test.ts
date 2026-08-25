// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-session-merge.test.ts
//
// d3-e4: the pure half of "a 10s tick must not throw away the pages an
// admin loaded". The rendered half is in app/admin/sessions/page.test.tsx.

import { describe, expect, it } from "vitest";
import { mergeAdminSessionFirstPage } from "./admin-session-merge.js";

/** Newest first, matching listActiveSessionsAdmin's ORDER BY. */
function row(id: string, startedAtMs: number, extra: Record<string, unknown> = {}) {
  return { id, startedAtMs, ...extra };
}

describe("mergeAdminSessionFirstPage (d3-e4)", () => {
  it("keeps rows below page 1's window — the ones Load more fetched", () => {
    const previous = [row("s3", 300), row("s2", 200), row("s1", 100)];
    const incoming = [row("s4", 400), row("s3", 300)];

    expect(mergeAdminSessionFirstPage(previous, incoming, { complete: false })).toEqual([
      row("s4", 400),
      row("s3", 300),
      row("s2", 200),
      row("s1", 100),
    ]);
  });

  it("drops a row inside page 1's window that page 1 no longer returns — that session ended", () => {
    const previous = [row("s3", 300), row("s2", 200), row("s1", 100)];
    const incoming = [row("s3", 300), row("s1", 100)];

    // s2 is at/above the boundary (s1) and absent from the fresh page.
    expect(mergeAdminSessionFirstPage(previous, incoming, { complete: false }).map((r) => r.id)).toEqual(["s3", "s1"]);
  });

  it("patches by id — the incoming copy of a known row wins", () => {
    const previous = [row("s1", 100, { status: "active" })];
    const incoming = [row("s1", 100, { status: "suspended" })];

    expect(mergeAdminSessionFirstPage(previous, incoming, { complete: true })[0]).toMatchObject({ status: "suspended" });
  });

  it("a complete page 1 IS the whole live set — nothing outside it survives", () => {
    const previous = [row("s3", 300), row("s2", 200), row("s1", 100)];
    const incoming = [row("s3", 300)];

    expect(mergeAdminSessionFirstPage(previous, incoming, { complete: true }).map((r) => r.id)).toEqual(["s3"]);
    expect(mergeAdminSessionFirstPage(previous, [], { complete: true })).toEqual([]);
  });

  it("breaks ties on id, exactly like the server's (startedAtMs DESC, id DESC) keyset", () => {
    // Same startedAtMs: "b" sorts before "a" descending, so "a" is BELOW
    // the boundary and must be kept.
    const previous = [row("b", 100), row("a", 100)];
    const incoming = [row("c", 100), row("b", 100)];

    expect(mergeAdminSessionFirstPage(previous, incoming, { complete: false }).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("never wipes the list on an (impossible) empty incomplete page", () => {
    const previous = [row("s1", 100)];
    expect(mergeAdminSessionFirstPage(previous, [], { complete: false })).toEqual(previous);
  });
});
