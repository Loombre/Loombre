// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/limit-param.spec.ts
//
// Review finding R-F9: `?limit` was parsed leniently everywhere but the
// contract's `maximum: 200` (components/parameters/Limit) was enforced
// NOWHERE — `?limit=1000000` reached the query layer as-is. This pins the
// one shared clamp (src/common/limit-param.ts) every cursor-list
// controller now routes through: lenient on malformed (ignored → contract
// default applies), clamped on oversized.

import { describe, expect, it } from "vitest";
import { LIMIT_PARAM_MAX, parseLimitParam } from "../src/common/limit-param.js";

describe("parseLimitParam (R-F9)", () => {
  it("ignores non-string / malformed / non-positive values (lenient posture unchanged)", () => {
    expect(parseLimitParam(undefined)).toBeUndefined();
    expect(parseLimitParam(50)).toBeUndefined(); // query values are strings; anything else is not ours
    expect(parseLimitParam("abc")).toBeUndefined();
    expect(parseLimitParam("")).toBeUndefined();
    expect(parseLimitParam("0")).toBeUndefined();
    expect(parseLimitParam("-5")).toBeUndefined();
  });

  it("passes in-range values through", () => {
    expect(parseLimitParam("1")).toBe(1);
    expect(parseLimitParam("50")).toBe(50);
    expect(parseLimitParam(String(LIMIT_PARAM_MAX))).toBe(LIMIT_PARAM_MAX);
  });

  it("CLAMPS oversized values to the contract maximum instead of forwarding them", () => {
    expect(parseLimitParam("201")).toBe(LIMIT_PARAM_MAX);
    expect(parseLimitParam("1000000")).toBe(LIMIT_PARAM_MAX);
  });

  it("honors a per-operation maximum override", () => {
    expect(parseLimitParam("400", 500)).toBe(400);
    expect(parseLimitParam("600", 500)).toBe(500);
  });
});
