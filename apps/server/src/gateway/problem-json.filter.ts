// SPDX-License-Identifier: AGPL-3.0-only
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";
import { MalformedCursorError } from "@loombre/db";
import { sanitizeInstancePath } from "./sanitize-instance.js";
import { badRequest, unprocessableEntity } from "./problem.exception.js";

/**
 * Stable URN identifying the RFC 9457 problem type for "the server hit an
 * error it didn't anticipate" (F1a, Wave-4 review). Not a real
 * dereferenceable URL — RFC 9457 only requires `type` be a URI reference
 * used as an identifier (same convention as UNAUTHENTICATED_PROBLEM_TYPE).
 */
export const INTERNAL_PROBLEM_TYPE = "urn:loombre:problem:internal";

/**
 * The two fixed `detail` strings a framework-minted 400 can carry (adi-F4).
 * Fixed, not derived: see `badRequest`'s doc comment in problem.exception.ts
 * for why nothing about the offending request may appear in the body.
 */
export const MALFORMED_BODY_DETAIL = "The request body is not valid JSON.";
export const UNPARSEABLE_REQUEST_DETAIL = "The request could not be parsed.";

/** A body this filter can send straight through: it already carries the two
 *  RFC 9457 members the Problem schema declares `required`. */
function isProblemShaped(body: unknown): boolean {
  return typeof body === "object" && body !== null && "title" in body && "status" in body;
}

/**
 * adi-F4: an `HttpException` this application did not raise itself. Every
 * error the product raises is a `ProblemException` (or one of the hand-rolled
 * problem-shaped exceptions next to it), so a NON-problem-shaped 400 can only
 * have been minted by @nestjs/core's `RoutesResolver.mapExternalException` —
 * body-parser's `SyntaxError`, or a path-param `URIError`. Recognised by
 * SHAPE, never by sniffing the message, so the check cannot drift when V8 or
 * express rewords a parser error.
 */
function isFrameworkMintedBadRequest(exception: unknown): exception is HttpException {
  return (
    exception instanceof HttpException &&
    exception.getStatus() === HttpStatus.BAD_REQUEST &&
    !isProblemShaped(exception.getResponse())
  );
}

/**
 * Which of the two fixed details a framework-minted 400 gets, decided
 * STRUCTURALLY. body-parser sets `req.body` to `undefined` before it starts
 * reading (lib/read.js) and only assigns the parsed value on success, so an
 * unset `body` on a request that ANNOUNCED one (`type-is.hasBody`'s rule: a
 * transfer-encoding, or a non-zero content-length) means the entity is what
 * failed to parse. Nothing here reads the request's CONTENT.
 */
function malformedRequestDetail(req: Request | undefined): string {
  if (req === undefined) return UNPARSEABLE_REQUEST_DETAIL;
  const announcesBody =
    req.headers["transfer-encoding"] !== undefined ||
    (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0");
  const bodyUnparsed = (req as { body?: unknown }).body === undefined;
  return announcesBody && bodyUnparsed ? MALFORMED_BODY_DETAIL : UNPARSEABLE_REQUEST_DETAIL;
}

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
 *
 * R1 review lane (leak-suite extension): `MalformedCursorError`
 * (packages/db/src/query/cursor.ts) is the SAME class of defect F1a
 * describes, one layer over — a client-supplied pagination cursor this
 * server did not mint (bad base64url/JSON, wrong payload shape, or a row
 * id that is not a uuid) is a CLIENT input mistake, not an unanticipated
 * server error, and every keyset-paginated list endpoint in the product
 * answered it with a 500. Handling it here rather than in each controller
 * is deliberate: cursors are minted and interpreted exclusively by the
 * guarded query layer, so there is exactly one error class to recognize
 * and one correct answer (422) for all of them — a per-controller
 * try/catch would be N copies that drift. The zone list ops
 * (openapi.yaml's `restricted` tag) declare the '422' explicitly since
 * this lane pins them; every other list op stays covered by its
 * `default: Problem` response, which is what that response is for.
 *
 * adi-F4 (QA 2026-08-21 remediation): the SAME class again, one layer
 * further out. A request body that is not valid JSON never reaches a
 * controller — express body-parser throws, and @nestjs/core's
 * `RoutesResolver.mapExternalException` rewrites the SyntaxError into
 * `new BadRequestException(err.message)`, i.e. the RAW V8 parse error
 * becomes the exception message. The "not problem-shaped" fallback below
 * then promoted it verbatim into `title`, and for V8's "Unexpected token"
 * form that message embeds a VERBATIM FRAGMENT OF THE SUBMITTED BODY — a
 * mistyped login body handed the password back in an error title. It is now
 * converted, like MalformedCursorError, into a complete problem body with a
 * fixed detail. This 400 is not declared per-operation in openapi.yaml (no
 * operation declares one); it rides `default: Problem`, same posture as the
 * 422 above.
 */
@Catch()
export class ProblemJsonExceptionFilter implements ExceptionFilter {
  catch(rawException: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const instance = req ? sanitizeInstancePath(req) : "about:blank";

    // Neither branch echoes its source exception's own message (both quote
    // the offending client input back — MalformedCursorError the cursor
    // payload, the framework-minted 400 a fragment of the request body).
    // Fixed detail strings, same posture as the generic 500 branch below.
    const exception: unknown =
      rawException instanceof MalformedCursorError
        ? unprocessableEntity("Malformed cursor.", instance)
        : isFrameworkMintedBadRequest(rawException)
          ? badRequest(malformedRequestDetail(req), instance)
          : rawException;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body: unknown = exception.getResponse();

      // The remaining un-shaped HttpExceptions are the deliberately MINIMAL
      // bare `NotFoundException()`s (unknown route, wrong method, invite
      // claim, inert first-admin setup, probe page): their
      // `{type:"about:blank", title:"Not Found", status:404}` body is
      // load-bearing anti-enumeration behaviour — byte-identical across all
      // of them, documented in openapi.yaml's getClaimState description and
      // pinned by conformance.spec.ts. Do NOT "complete" it with a
      // detail/instance without moving that documentation first (adi-F3).
      const problem = isProblemShaped(body)
        ? body
        : { type: "about:blank", title: exception.message, status };

      res.status(status);
      res.setHeader("Content-Type", "application/problem+json");
      res.send(JSON.stringify(problem));
      return;
    }

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
