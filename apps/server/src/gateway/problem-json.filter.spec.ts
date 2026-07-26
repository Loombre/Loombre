// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/gateway/problem-json.filter.spec.ts
//
// F1a (Wave-4 review, MED): a malformed-UUID path param used to trigger a
// raw Postgres uuid-cast error that escaped this filter entirely (it was
// previously @Catch(HttpException)-only), surfacing as a bare, non-RFC-9457
// `{"statusCode":500}` with no structured server-side log. This is a pure
// unit test of the filter itself (mocked ArgumentsHost/Response — no HTTP
// server needed, same "test the exception object/filter directly" pattern
// as rate-limit.exception.spec.ts) proving BOTH halves of the fix:
//   1. Existing HttpException handling is unchanged (still problem+json,
//      still passes an already-problem-shaped body through as-is).
//   2. A non-HttpException (e.g. the raw driver error F1's root cause
//      throws) now gets a generic RFC 9457 500 body — no message/stack
//      echoed to the client — plus exactly one structured server-side log
//      line.
//
// The HTTP-level "malformed id -> 404 before this filter is even reached"
// proof (F1b, the PRIMARY fix) lives in apps/server/test/
// security-hardening.e2e.spec.ts against representative real routes.

import { describe, expect, it, vi, afterEach } from "vitest";
import { HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { ProblemJsonExceptionFilter, INTERNAL_PROBLEM_TYPE } from "./problem-json.filter.js";
import { UnauthenticatedException } from "./unauthenticated.exception.js";

function fakeHost(instance = "/movies/not-a-uuid"): {
  host: ArgumentsHost;
  res: { status: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
} {
  const res = {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  const req = { method: "GET", originalUrl: instance };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => req,
    }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

describe("ProblemJsonExceptionFilter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still serializes an already problem-shaped HttpException as-is (unchanged behavior)", () => {
    const filter = new ProblemJsonExceptionFilter();
    const { host, res } = fakeHost("/auth/login");
    const exception = new UnauthenticatedException("/auth/login");

    filter.catch(exception, host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/problem+json");
    const body = JSON.parse(res.send.mock.calls[0]![0] as string);
    expect(body.title).toBe("Unauthenticated");
    expect(body.status).toBe(401);
  });

  it("still wraps a non-problem-shaped HttpException (e.g. NotFoundException) in a minimal envelope", () => {
    const filter = new ProblemJsonExceptionFilter();
    const { host, res } = fakeHost("/nope");
    const exception = new NotFoundException();

    filter.catch(exception, host);

    expect(res.status).toHaveBeenCalledWith(404);
    const body = JSON.parse(res.send.mock.calls[0]![0] as string);
    expect(body.type).toBe("about:blank");
    expect(body.status).toBe(404);
    expect(body.title).toBe("Not Found");
  });

  it("F1a: a non-HttpException (raw driver-style error) becomes a generic RFC 9457 500, no message/stack echoed", () => {
    const filter = new ProblemJsonExceptionFilter();
    const { host, res } = fakeHost("/movies/not-a-uuid");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const raw = new Error('invalid input syntax for type uuid: "not-a-uuid"');
    filter.catch(raw, host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/problem+json");
    const body = JSON.parse(res.send.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(body["status"]).toBe(500);
    expect(body["type"]).toBe(INTERNAL_PROBLEM_TYPE);
    expect(body["title"]).toBe("Internal Server Error");
    // The client-facing body must NEVER echo the raw error message or a
    // stack trace.
    expect(JSON.stringify(body)).not.toContain("invalid input syntax");
    expect(body).not.toHaveProperty("stack");

    // Logged exactly once, server-side, structured.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleErrorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(logged["event"]).toBe("unhandled_exception");
    expect(logged["message"]).toContain("invalid input syntax");
  });

  it("F1a: also catches a non-Error thrown value without crashing the filter itself", () => {
    const filter = new ProblemJsonExceptionFilter();
    const { host, res } = fakeHost("/x");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => filter.catch("a plain string throw", host)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("F1a: instance is sanitized (never echoes a ?token= query value)", () => {
    const filter = new ProblemJsonExceptionFilter();
    const { host, res } = fakeHost("/playback/sessions/not-a-uuid/file?token=super-secret-access-jwt");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    filter.catch(new Error("boom"), host);

    const body = JSON.parse(res.send.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("super-secret-access-jwt");
  });

  it("sanity: HttpException is still the branch taken for a real HttpException subclass", () => {
    const filter = new ProblemJsonExceptionFilter();
    const { host, res } = fakeHost("/x");
    filter.catch(new HttpException("teapot", 418), host);
    expect(res.status).toHaveBeenCalledWith(418);
  });
});
