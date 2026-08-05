// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/gateway/problem.exception.ts
//
// Generic RFC 9457 problem+json exception (STATE.md D17/D21) for the
// non-401 error responses this wave's controllers need (403/422). Mirrors
// unauthenticated.exception.ts's shape so ProblemJsonExceptionFilter's
// "already problem-shaped" check (has `title` + `status`) passes without a
// wrapping envelope, and every error this server produces is
// schema-consistent regardless of which controller threw it.

import { HttpException, HttpStatus } from "@nestjs/common";

export class ProblemException extends HttpException {
  constructor(params: {
    status: HttpStatus;
    type: string;
    title: string;
    detail: string;
    instance: string;
    code?: string;
  }) {
    super(
      {
        type: params.type,
        title: params.title,
        status: params.status,
        detail: params.detail,
        instance: params.instance,
        ...(params.code !== undefined ? { code: params.code } : {}),
      },
      params.status,
    );
  }
}

export function unprocessableEntity(detail: string, instance: string, code?: string): ProblemException {
  return new ProblemException({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    type: "urn:loombre:problem:validation",
    title: "Unprocessable Entity",
    detail,
    instance,
    ...(code !== undefined ? { code } : {}),
  });
}

export function forbidden(detail: string, instance: string, code?: string): ProblemException {
  return new ProblemException({
    status: HttpStatus.FORBIDDEN,
    type: "urn:loombre:problem:forbidden",
    title: "Forbidden",
    detail,
    instance,
    ...(code !== undefined ? { code } : {}),
  });
}

export function unauthorized(detail: string, instance: string, code?: string): ProblemException {
  return new ProblemException({
    status: HttpStatus.UNAUTHORIZED,
    type: "urn:loombre:problem:unauthorized",
    title: "Unauthorized",
    detail,
    instance,
    ...(code !== undefined ? { code } : {}),
  });
}

/**
 * RFC 9457 409, first consumer: Addendum A (STATE.md, admin-configurable
 * server settings) A8's env-pin lockout — PUT /v1/admin/settings/{key}
 * against a key currently governed by an env pin (settings.service.ts's
 * `locked` check). The env value always wins regardless of what's sent;
 * this is a conflict, not a validation failure, because the SUBMITTED value
 * may be perfectly schema-valid — it simply cannot take effect while the
 * pin is active.
 */
export function conflict(detail: string, instance: string, code?: string): ProblemException {
  return new ProblemException({
    status: HttpStatus.CONFLICT,
    type: "urn:loombre:problem:conflict",
    title: "Conflict",
    detail,
    instance,
    ...(code !== undefined ? { code } : {}),
  });
}

/**
 * RFC 9457 404, used for EVERY "resource not found or not visible to this
 * viewer" case across the catalog/images/libraries/etc. controllers
 * (mission spec: invisibility must be indistinguishable from nonexistence
 * — packages/db's guarded queries already collapse both cases into
 * `undefined`/`[]` before this is ever called, so callers never know which
 * one happened and cannot leak it even by accident). `detail` MUST be a
 * fixed, generic per-entity-kind string — never anything that varies by
 * WHY the lookup failed — so that a genuinely nonexistent random UUID and a
 * real-but-restricted-and-uncleared id produce byte-identical problem+json
 * bodies (apart from `instance`, which is the request path and legitimately
 * differs).
 */
export function notFound(detail: string, instance: string, code?: string): ProblemException {
  return new ProblemException({
    status: HttpStatus.NOT_FOUND,
    type: "urn:loombre:problem:not-found",
    title: "Not Found",
    detail,
    instance,
    ...(code !== undefined ? { code } : {}),
  });
}

/**
 * RFC 9457 501, first consumer: STATE.md "Loombre Remote — embedded
 * WireGuard + three-path wizard + reachability proof + posture card"
 * Wave 0 (lane/remote-base, RG15) — every admin op mounted under
 * apps/server/src/remote/ passes requireLiveAdmin FIRST (a real admin
 * gets a real, honest "not built yet" instead of a coincidental catch-all
 * 404), then throws this. Distinct from a bare `NotFoundException()`
 * (which a caller cannot tell apart from "doesn't exist"): 501 means "this
 * IS a real, documented operation — it just isn't implemented on this
 * branch yet," so the contract-conformance walk (apps/server/test/
 * conformance.spec.ts) can assert an EXACT expected status per op rather
 * than a coincidental one. Each replacing lane deletes its own call sites
 * of this factory as it lands real behavior; the factory itself stays for
 * whichever op hasn't been replaced yet.
 */
export function notImplemented(detail: string, instance: string, code?: string): ProblemException {
  return new ProblemException({
    status: HttpStatus.NOT_IMPLEMENTED,
    type: "urn:loombre:problem:not-implemented",
    title: "Not Implemented",
    detail,
    instance,
    ...(code !== undefined ? { code } : {}),
  });
}
