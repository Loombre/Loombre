// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/rate-limit-exception.filter.ts
//
// Serializes RateLimitException as RFC 9457 application/problem+json PLUS
// a standard Retry-After header (STATE.md P2.1/P2.12/P4.15) — the shared
// global ProblemJsonExceptionFilter (apps/server/src/gateway/problem-json.
// filter.ts) has no concept of a per-exception header, so rather than
// editing shared gateway code this stays a narrow, controller-scoped
// filter applied via `@UseFilters` on every controller that can throw
// RateLimitException (AuthController/RestrictedController, and — P4.15's
// sweep — SystemController/DataFreedomController/ImagesController/
// HlsFileController/SessionFileController/SubtitleFileController). Nest
// resolves controller-level filters before global ones for exceptions they
// declare via `@Catch` (RouterExceptionFilters merges [global, class,
// method] then reverses, so class-scoped filters are tried first) — the
// global HttpException filter never sees a RateLimitException.
//
// RELOCATED from session/ to common/ — see ./rate-limiter.ts's header for
// the full cross-module rationale.

import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { RateLimitException } from "./rate-limit.exception.js";

@Catch(RateLimitException)
export class RateLimitExceptionFilter implements ExceptionFilter {
  catch(exception: RateLimitException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const retryAfterSeconds = Math.max(1, Math.ceil(exception.retryAfterMs / 1000));

    res.status(exception.getStatus());
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.setHeader("Content-Type", "application/problem+json");
    res.send(JSON.stringify(exception.getResponse()));
  }
}
