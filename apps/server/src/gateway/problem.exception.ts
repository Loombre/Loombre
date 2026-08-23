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
    /** Additional RFC 9457 extension members (Problem's `additionalProperties:
     *  true`) — spread onto the body alongside type/title/status/detail/
     *  instance/code. First consumer: `remediation` on the filesystem-
     *  permission-denied 403 (FilesystemPermissionRemediation, packages/
     *  contract/openapi.yaml). Additive only — never a key already listed
     *  above, so callers cannot silently override the fixed fields. */
    extensions?: Record<string, unknown>;
  }) {
    // `extensions` is spread FIRST, so every fixed RFC 9457 field below
    // overwrites anything of the same name it might carry — reserved
    // members always win, which is what the doc comment above promises.
    // Before this ordering, extensions was spread LAST: `forbidden(detail,
    // instance, code, { status: 200 })` produced an HTTP 403 whose OWN BODY
    // claimed status 200 (code review finding). `code` is reserved the same
    // way: assigned unconditionally after the spread, then deleted when the
    // caller passed none, so a rogue `code` inside `extensions` cannot
    // survive either (JSON.stringify drops an `undefined`-valued key, same
    // wire shape as never having set it).
    const body: Record<string, unknown> = {
      ...params.extensions,
      type: params.type,
      title: params.title,
      status: params.status,
      detail: params.detail,
      instance: params.instance,
      code: params.code,
    };
    if (params.code === undefined) {
      delete body["code"];
    }
    super(body, params.status);
  }
}

/**
 * RFC 9457 400, adi-F4 (QA 2026-08-21). NO controller in this server throws
 * a 400 — every client-input rejection it raises itself is a 422
 * (`unprocessableEntity`, schema/business-rule validation). A 400 can only
 * come from the FRAMEWORK, out of @nestjs/core's
 * `RoutesResolver.mapExternalException`, which rewrites two express-level
 * failures into a bare `new BadRequestException(err.message)`:
 *   - body-parser's `SyntaxError` (the request entity is not valid JSON), and
 *   - a `URIError` from a path param with invalid percent-encoding.
 * Both of those messages are raw internal parser text that QUOTES THE
 * OFFENDING CLIENT INPUT back (V8's "Unexpected token" form embeds a verbatim
 * fragment of the submitted body — potentially a credential), so
 * ProblemJsonExceptionFilter converts them here instead of letting them reach
 * `title`. `detail` is therefore always one of a fixed set of strings; it is
 * never built from request content. Same no-echo posture as the filter's
 * `MalformedCursorError` branch and its generic 500.
 */
export function badRequest(detail: string, instance: string, code?: string): ProblemException {
  return new ProblemException({
    status: HttpStatus.BAD_REQUEST,
    type: "urn:loombre:problem:malformed-request",
    title: "Bad Request",
    detail,
    instance,
    ...(code !== undefined ? { code } : {}),
  });
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

/**
 * `extensions`, when supplied, is spread onto the problem body as-is
 * (additive RFC 9457 extension members — Problem's `additionalProperties:
 * true`). Optional and additive: every existing 2/3-arg call site is
 * unaffected. First consumer: the filesystem-permission-denied 403's
 * `remediation` member (admin.controller.ts's browseDirectories).
 */
export function forbidden(
  detail: string,
  instance: string,
  code?: string,
  extensions?: Record<string, unknown>,
): ProblemException {
  return new ProblemException({
    status: HttpStatus.FORBIDDEN,
    type: "urn:loombre:problem:forbidden",
    title: "Forbidden",
    detail,
    instance,
    ...(code !== undefined ? { code } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
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

/**
 * RFC 9457 503, first consumer: STATE.md "Loombre Remote" lane WG1 —
 * enableRemoteWireguard when packages/wg-native's native library isn't
 * built/loadable on this platform (a real Go build failure, or Go simply
 * not installed on a dev machine — scripts/build.mjs's graceful-skip
 * posture, mirroring apps/worker's ffmpeg detection). Distinct from 501
 * (notImplemented): this operation IS implemented — the underlying
 * platform component just isn't available RIGHT NOW, which is exactly
 * what 503 means (a transient/environmental unavailability, not "not
 * built"). CI always has this available (RG1/RG14: actions/setup-go +
 * LOOMBRE_REQUIRE_WG=1 on the gate job); this path exists for the local
 * dev without-Go case only.
 */
export function serviceUnavailable(detail: string, instance: string, code?: string): ProblemException {
  return new ProblemException({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    type: "urn:loombre:problem:service-unavailable",
    title: "Service Unavailable",
    detail,
    instance,
    ...(code !== undefined ? { code } : {}),
  });
}
