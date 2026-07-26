// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/rate-limit.exception.ts
//
// RFC 9457 429 problem+json for a tripped rate limit (STATE.md P2.1/P2.12/
// P4.15). Mirrors apps/server/src/gateway/problem.exception.ts's shape/
// helper-function convention (unauthorized/forbidden/unprocessableEntity)
// — kept as its own small class (not folded into gateway's) because it
// carries an extra `retryAfterMs` field the shared gateway ProblemException
// does not, which RateLimitExceptionFilter needs to compute the
// Retry-After header.
//
// RELOCATED from session/ to common/ in the P4.15 rate-limit sweep — see
// ./rate-limiter.ts's header for the full cross-module rationale (this
// exception is now thrown from catalog/playback controllers too, which
// cannot import anything from session/).

import { HttpException, HttpStatus } from "@nestjs/common";

export class RateLimitException extends HttpException {
  readonly retryAfterMs: number;

  constructor(detail: string, instance: string, retryAfterMs: number) {
    super(
      {
        type: "urn:loombre:problem:rate-limited",
        title: "Too Many Requests",
        status: HttpStatus.TOO_MANY_REQUESTS,
        detail,
        instance,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
    this.retryAfterMs = retryAfterMs;
  }
}

export function tooManyRequests(detail: string, instance: string, retryAfterMs: number): RateLimitException {
  return new RateLimitException(detail, instance, retryAfterMs);
}
