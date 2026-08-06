// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/data-freedom.controller.spec.ts
//
// V1-013 (audit fafa47f, Fix Wave 4): GET /export writes res.status(200) +
// res.setHeader(...) + the opening `res.write('{"exportedAtMs":...')`
// BEFORE the streaming loop even starts, so by the time exportData()'s
// generator (or the per-item getCatalogDetail call) can throw, headers are
// already committed. Pre-fix, that throw propagates straight out of
// exportArchive uncaught — in the real app it lands in
// ProblemJsonExceptionFilter, whose generic branch unconditionally calls
// res.setHeader AGAIN and throws Node's ERR_HTTP_HEADERS_SENT while trying
// to report the very error it's handling, leaving the client with
// truncated-but-still-200 JSON. This test simulates a mid-stream failure
// by injection (same seam philosophy as the stash adapter fix: deterministic,
// no reliance on a real I/O fault) — exportData's async generator throws
// after yielding real chunks — and asserts the FIXED handler:
//   1. never calls res.end() (no attempt to close a truncated body as if
//      it were complete), and
//   2. aborts the connection (res.destroy()) so an HTTP-compliant client
//      sees a transport-level error instead of a 200 that merely stops.
//
// Pre-fix, exportArchive(req, res) simply REJECTS with the injected error
// (no try/catch exists yet) — that's what "watch it fail first" looks like
// here: this test's own `await controller.exportArchive(...)` throws
// instead of resolving.
//
// getCatalogDetail/exportData are mocked at the `@loombre/db` module
// boundary (no live Postgres needed) — same convention as
// gateway/auth.guard.spec.ts.

import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";

const dbMocks = vi.hoisted(() => ({
  exportData: vi.fn(),
  getCatalogDetail: vi.fn(),
}));

vi.mock("@loombre/db", () => ({
  exportData: dbMocks.exportData,
  getCatalogDetail: dbMocks.getCatalogDetail,
}));

import { DataFreedomController } from "./data-freedom.controller.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import type { DbProvider } from "../common/db.provider.js";
import type { ViewerContextProvider } from "../common/viewer-context.provider.js";
import type { JobQueueProvider } from "../common/job-queue.provider.js";

function makeReq(): AuthenticatedRequest {
  return {
    originalUrl: "/export",
    user: { userId: "0191c1c0-0000-7000-8000-000000000001" },
  } as unknown as AuthenticatedRequest;
}

function makeViewerContextProvider(): ViewerContextProvider {
  return {
    resolve: vi.fn().mockResolvedValue({
      userId: "0191c1c0-0000-7000-8000-000000000001",
      allowedLibraryIds: [],
      restrictedCleared: false,
    }),
  } as unknown as ViewerContextProvider;
}

// Mimics real http.ServerResponse's contract closely enough for this test:
// the first write() commits headers (headersSent flips true synchronously,
// exactly like Express), end()/destroy() are terminal.
function makeFakeResponse() {
  const writes: string[] = [];
  const res = {
    headersSent: false,
    statusCode: 0,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    setHeader: vi.fn(() => res),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      res.headersSent = true;
      return true;
    }),
    end: vi.fn(),
    destroy: vi.fn(),
  };
  return { res: res as unknown as Response, writes, raw: res };
}

function makeController(): DataFreedomController {
  return new DataFreedomController(
    { db: {} } as unknown as DbProvider,
    makeViewerContextProvider(),
    {} as unknown as JobQueueProvider,
  );
}

describe("GET /export mid-stream failure (V1-013)", () => {
  it("does not silently truncate: no res.end(), connection aborted instead", async () => {
    dbMocks.getCatalogDetail.mockReset();
    dbMocks.exportData.mockReset();
    dbMocks.exportData.mockImplementation(async function* () {
      yield {
        kind: "library",
        library: {
          id: "lib-1",
          name: "Movies",
          mediaKind: "video",
          contentClass: "general",
          paths: ["/media/movies"],
          createdAtMs: 1,
        },
      };
      yield {
        kind: "item",
        item: { id: "item-1", itemType: "movie", progress: null },
      };
      // The injected mid-stream failure — analogous to a page-2 listItems
      // query or a per-item getCatalogDetail call throwing partway through
      // a real export.
      throw new Error("simulated mid-stream DB failure");
    });
    dbMocks.getCatalogDetail.mockResolvedValue(null);

    const controller = makeController();
    const { res, writes, raw } = makeFakeResponse();

    // Pre-fix: this rejects (no try/catch around the loop) — post-fix: it
    // resolves, having handled the failure itself.
    await controller.exportArchive(makeReq(), res);

    // Real data already reached the wire before the failure — proves this
    // genuinely is a MID-stream case, not a fail-before-any-write case.
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((w) => w.includes("exportedAtMs"))).toBe(true);

    // The defect: silently finishing the JSON as if the export were
    // complete. Must never happen once a failure occurred.
    expect(raw.end).not.toHaveBeenCalled();
    expect(writes.some((w) => w.includes('"playlists":[]}'))).toBe(false);

    // The fix: abort the connection so the client can't mistake this for
    // a complete, valid export.
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it("a failure before any byte is written still gets a normal (thrown) error path", async () => {
    dbMocks.getCatalogDetail.mockReset();
    dbMocks.exportData.mockReset();

    const viewerContextProvider = {
      resolve: vi.fn().mockRejectedValue(new Error("resolveViewer failed before any write")),
    } as unknown as ViewerContextProvider;
    const controller = new DataFreedomController(
      { db: {} } as unknown as DbProvider,
      viewerContextProvider,
      {} as unknown as JobQueueProvider,
    );

    const { res, raw } = makeFakeResponse();

    await expect(controller.exportArchive(makeReq(), res)).rejects.toThrow(
      "resolveViewer failed before any write",
    );
    expect(raw.destroy).not.toHaveBeenCalled();
    expect(raw.write).not.toHaveBeenCalled();
  });
});
