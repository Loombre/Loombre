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
//
// adi-F4 (QA 2026-08-21, P2) added the third branch these cover: a 400 the
// FRAMEWORK minted (@nestjs/core rewrites express body-parser's SyntaxError
// into `new BadRequestException(<raw V8 parse error>)`, and that message
// quotes a fragment of the submitted body back). Its HTTP-level proof lives
// in apps/server/test/malformed-json-body.e2e.spec.ts.

import { describe, expect, it, vi, afterEach } from "vitest";
import { BadRequestException, HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import {
  ProblemJsonExceptionFilter,
  INTERNAL_PROBLEM_TYPE,
  MALFORMED_BODY_DETAIL,
  UNPARSEABLE_REQUEST_DETAIL,
} from "./problem-json.filter.js";
import { UnauthenticatedException } from "./unauthenticated.exception.js";

function fakeHost(
  instance = "/movies/not-a-uuid",
  reqExtras: { headers?: Record<string, string>; body?: unknown } = {},
): {
  host: ArgumentsHost;
  res: { status: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
} {
  const res = {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  const req = { method: "GET", originalUrl: instance, headers: reqExtras.headers ?? {}, ...reqExtras };
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

  // adi-F4 (QA 2026-08-21, P2). @nestjs/core's
  // RoutesResolver.mapExternalException turns express body-parser's
  // SyntaxError into `new BadRequestException(<raw V8 parse error>)`, and
  // that message embeds a verbatim fragment of the submitted body. The
  // HTTP-level proof is apps/server/test/malformed-json-body.e2e.spec.ts;
  // these pin the filter's own recognition rule (SHAPE, never the message).
  it("adi-F4: a framework-minted BadRequestException becomes a complete problem body, no parser message echoed", () => {
    const filter = new ProblemJsonExceptionFilter();
    const { host, res } = fakeHost("/auth/login", { headers: { "content-length": "34" } });

    filter.catch(
      new BadRequestException('Unexpected token \'h\', "{"password": hunter2}" is not valid JSON'),
      host,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/problem+json");
    const body = JSON.parse(res.send.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(body["type"]).toBe("urn:loombre:problem:malformed-request");
    expect(body["title"]).toBe("Bad Request");
    expect(body["status"]).toBe(400);
    expect(body["detail"]).toBe(MALFORMED_BODY_DETAIL);
    expect(body["instance"]).toBe("/auth/login");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(JSON.stringify(body)).not.toContain("Unexpected token");
  });

  it("adi-F4: a 400 on a request that announced no body gets the generic detail (path-param URIError)", () => {
    const filter = new ProblemJsonExceptionFilter();
    const { host, res } = fakeHost("/movies/%FF");

    filter.catch(new BadRequestException("Failed to decode param '%FF'"), host);

    const body = JSON.parse(res.send.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(body["detail"]).toBe(UNPARSEABLE_REQUEST_DETAIL);
    expect(JSON.stringify(body)).not.toContain("Failed to decode param");
  });

  it("adi-F4: an ALREADY problem-shaped 400 is passed through untouched (the rule is shape, not status)", () => {
    const filter = new ProblemJsonExceptionFilter();
    const { host, res } = fakeHost("/x");

    filter.catch(new HttpException({ type: "urn:loombre:problem:custom", title: "Custom", status: 400 }, 400), host);

    const body = JSON.parse(res.send.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(body["type"]).toBe("urn:loombre:problem:custom");
    expect(body["title"]).toBe("Custom");
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
