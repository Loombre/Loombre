// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/rate-limit.exception.spec.ts
//
// RFC 9457 shape for the 429 rate-limit exception (STATE.md P2.1/P2.12).
// Pure unit test of the exception object itself; the HTTP-level
// Retry-After header behavior (RateLimitExceptionFilter) is proven by
// apps/server/test/auth-security.e2e.spec.ts against a real request.

import { describe, expect, it } from "vitest";
import { HttpStatus } from "@nestjs/common";
import { tooManyRequests } from "./rate-limit.exception.js";

describe("tooManyRequests", () => {
  it("produces an RFC 9457 problem body with status 429", () => {
    const exception = tooManyRequests("Too many login attempts.", "/auth/login", 5000);
    expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    const body = exception.getResponse() as Record<string, unknown>;
    expect(body["status"]).toBe(429);
    expect(body["title"]).toBe("Too Many Requests");
    expect(body["detail"]).toBe("Too many login attempts.");
    expect(body["instance"]).toBe("/auth/login");
    expect(typeof body["type"]).toBe("string");
  });

  it("carries retryAfterMs for the filter to translate into a Retry-After header", () => {
    const exception = tooManyRequests("x", "/auth/login", 1234);
    expect(exception.retryAfterMs).toBe(1234);
  });
});
