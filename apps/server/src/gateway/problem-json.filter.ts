// SPDX-License-Identifier: AGPL-3.0-only
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";
import { sanitizeInstancePath } from "./sanitize-instance.js";

/**
 * Stable URN identifying the RFC 9457 problem type for "the server hit an
 * error it didn't anticipate" (F1a, Wave-4 review). Not a real
 * dereferenceable URL — RFC 9457 only requires `type` be a URI reference
 * used as an identifier (same convention as UNAUTHENTICATED_PROBLEM_TYPE).
 */
export const INTERNAL_PROBLEM_TYPE = "urn:loombre:problem:internal";

/**
 * Serializes every thrown exception as RFC 9457 `application/problem+json`
 * (STATE.md D17/D21) instead of Nest's built-in default filter, which sends
 * plain `application/json` for HttpExceptions and, for anything else,
 * whatever Nest's base ExceptionsHandler falls back to (a bare
 * `{"statusCode":500,"message":"Internal server error"}` — not RFC 9457
 * shaped at all).
 *
 * F1a (Wave-4 review): this filter used to be `@Catch(HttpException)`,
 * meaning a non-HttpException (e.g. Postgres's raw uuid-cast error, thrown
 * when a malformed :id path param reached the DB unchanged) fell straight
 * through to Nest's default handler — producing exactly that bare, non-
 * problem-shaped 500. It is now a catch-all (`@Catch()`, no argument): any
 * HttpException keeps its existing behavior below; anything else is logged
 * ONCE, server-side, structured (never to the client — no message/stack
 * echo, so an internal error can't leak implementation details) and
 * answered with a generic 500 problem+json body. F1b (see
 * gateway/require-uuid-param.ts) is the PRIMARY fix — malformed ids are
 * now rejected before ever reaching the DB — this is the defense-in-depth
 * backstop for every other kind of unanticipated server error.
 */
@Catch()
export class ProblemJsonExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body: unknown = exception.getResponse();

      const isProblemShaped =
        typeof body === "object" &&
        body !== null &&
        "title" in body &&
        "status" in body;

      const problem = isProblemShaped
        ? body
        : { type: "about:blank", title: exception.message, status };

      res.status(status);
      res.setHeader("Content-Type", "application/problem+json");
      res.send(JSON.stringify(problem));
      return;
    }

    const req = host.switchToHttp().getRequest<Request>();
    const instance = req ? sanitizeInstancePath(req) : "about:blank";

    // Structured, single-line, server-side-only log (never sent to the
    // client) — the closest thing this codebase has to a request-error
    // log; deliberately plain console.error (no logging framework dep,
    // consistent with main.ts's own console.log/console.error usage).
    console.error(
      JSON.stringify({
        level: "error",
        event: "unhandled_exception",
        method: req?.method,
        instance,
        message: exception instanceof Error ? exception.message : String(exception),
        timestamp: new Date().toISOString(),
      }),
    );

    const status = HttpStatus.INTERNAL_SERVER_ERROR;
    res.status(status);
    res.setHeader("Content-Type", "application/problem+json");
    res.send(
      JSON.stringify({
        type: INTERNAL_PROBLEM_TYPE,
        title: "Internal Server Error",
        status,
        detail: "An unexpected error occurred.",
        instance,
      }),
    );
  }
}
