// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/progress.controller.spec.ts
//
// V1-009 (audit fafa47f, Fix Wave 4): PUT /progress/{itemId} validated
// positionMs/durationMs as `typeof === "number"` only — a non-integer
// (12.5) sailed past validation, flowed unmodified into upsertProgress ->
// progress-write.ts, and hit `progress.position_ms BIGINT` as an
// unhandled 500 instead of the contract's declared 422. All of this
// happens before any DB touch (requireUuidParam, then the body checks,
// THEN resolveViewer/upsertProgress), so this is a pure, DB-free unit
// test — dbProvider/viewerContextProvider are never read on the failing
// paths below.

import { describe, expect, it } from "vitest";
import { ProgressController } from "./progress.controller.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import type { DbProvider } from "../common/db.provider.js";
import type { ViewerContextProvider } from "../common/viewer-context.provider.js";

const ITEM_ID = "0191c1c0-0000-7000-8000-000000000099";

function makeReq(): AuthenticatedRequest {
  return {
    originalUrl: `/progress/${ITEM_ID}`,
    user: { userId: "0191c1c0-0000-7000-8000-000000000001" },
  } as unknown as AuthenticatedRequest;
}

// Neither dependency is ever read on the 422 paths under test (validation
// throws before resolveViewer/upsertProgress) — untyped stand-ins, same as
// invites.controller.spec.ts's dependency-free posture for pure logic.
const controller = new ProgressController({} as DbProvider, {} as ViewerContextProvider);

describe("PUT /progress/{itemId} body validation (V1-009)", () => {
  it("422s a non-integer positionMs instead of reaching the DB as a 500", async () => {
    await expect(
      controller.putProgress(ITEM_ID, { positionMs: 12.5, state: "in-progress" }, makeReq()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("422s NaN positionMs", async () => {
    await expect(
      controller.putProgress(ITEM_ID, { positionMs: NaN, state: "in-progress" }, makeReq()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("422s Infinity positionMs", async () => {
    await expect(
      controller.putProgress(ITEM_ID, { positionMs: Infinity, state: "in-progress" }, makeReq()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("422s a BIGINT-overflowing positionMs (1e20: isInteger-true, isSafeInteger-false)", async () => {
    // Number.isInteger(1e20) === true, but 1e20 > 2^63-1 overflows the
    // BIGINT column — the same unhandled-500 class V1-009 was filed about,
    // via a different input. Number.isSafeInteger closes it.
    await expect(
      controller.putProgress(ITEM_ID, { positionMs: 1e20, state: "in-progress" }, makeReq()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("422s a BIGINT-overflowing durationMs", async () => {
    await expect(
      controller.putProgress(
        ITEM_ID,
        { positionMs: 1000, durationMs: 1e20, state: "in-progress" },
        makeReq(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("still accepts an integer positionMs (regression guard: the fix must not over-reject)", async () => {
    await expect(
      controller.putProgress(ITEM_ID, { positionMs: 1000, state: "in-progress" }, makeReq()),
    ).rejects.not.toMatchObject({ status: 422 }); // fails later (no live DB) — never on validation
  });

  it("422s a non-integer durationMs", async () => {
    await expect(
      controller.putProgress(
        ITEM_ID,
        { positionMs: 1000, durationMs: 999.9, state: "in-progress" },
        makeReq(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("still accepts durationMs: null (unchanged behavior)", async () => {
    await expect(
      controller.putProgress(
        ITEM_ID,
        { positionMs: 1000, durationMs: null, state: "in-progress" },
        makeReq(),
      ),
    ).rejects.not.toMatchObject({ status: 422 });
  });
});
