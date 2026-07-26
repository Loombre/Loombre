// SPDX-License-Identifier: AGPL-3.0-only
import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * Stable URN identifying the RFC 9457 problem type for "no/invalid Bearer
 * token" (STATE.md D21). Not a real dereferenceable URL — RFC 9457 only
 * requires `type` be a URI reference used as an identifier.
 */
export const UNAUTHENTICATED_PROBLEM_TYPE = "urn:loombre:problem:unauthenticated";

/**
 * Thrown by AuthGuard for any request lacking a well-formed Bearer token.
 * Carries an RFC 9457 problem body; ProblemJsonExceptionFilter serializes it
 * as `application/problem+json` (Nest's default filter would otherwise send
 * `application/json`).
 */
export class UnauthenticatedException extends HttpException {
  constructor(instance: string) {
    super(
      {
        type: UNAUTHENTICATED_PROBLEM_TYPE,
        title: "Unauthenticated",
        status: HttpStatus.UNAUTHORIZED,
        detail: "Missing or invalid Bearer token.",
        instance,
      },
      HttpStatus.UNAUTHORIZED,
    );
  }
}
