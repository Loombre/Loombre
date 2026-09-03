// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { decideHardSeekDispatch, HARD_SEEK_COALESCE_MS } from "./seek-coalesce.js";

describe("decideHardSeekDispatch (SPF-5)", () => {
  it("dispatches immediately when nothing has dispatched yet", () => {
    expect(decideHardSeekDispatch(null, 1_000)).toEqual({ immediate: true });
  });

  it("dispatches immediately at exactly the coalesce window's edge", () => {
    expect(decideHardSeekDispatch(1_000, 1_000 + HARD_SEEK_COALESCE_MS)).toEqual({ immediate: true });
  });

  it("dispatches immediately once well past the coalesce window", () => {
    expect(decideHardSeekDispatch(1_000, 1_000 + HARD_SEEK_COALESCE_MS + 5_000)).toEqual({ immediate: true });
  });

  it("defers a seek issued inside the coalesce window, with the remaining time to the window's edge", () => {
    expect(decideHardSeekDispatch(1_000, 1_050)).toEqual({ immediate: false, deferMs: HARD_SEEK_COALESCE_MS - 50 });
  });

  it("defers a seek issued the instant after the previous dispatch (the smallest possible gap)", () => {
    expect(decideHardSeekDispatch(1_000, 1_001)).toEqual({ immediate: false, deferMs: HARD_SEEK_COALESCE_MS - 1 });
  });

  it("a seek issued at the exact same instant as the previous dispatch defers for the full window", () => {
    expect(decideHardSeekDispatch(1_000, 1_000)).toEqual({ immediate: false, deferMs: HARD_SEEK_COALESCE_MS });
  });
});
