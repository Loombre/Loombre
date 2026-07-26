// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/gateway/require-uuid-param.ts
//
// F1 (Wave-4 review): a malformed :id path param (anything that isn't a
// syntactically valid UUID) used to reach the DB layer unchanged, where
// Postgres's implicit `uuid` cast throws — that raw driver error escaped
// ProblemJsonExceptionFilter entirely (it was @Catch(HttpException)-only)
// and surfaced as a bare, non-RFC-9457 `{"statusCode":500}` with DB error
// log spam for something that isn't really a server error at all. The real
// fix is two-layered (see problem-json.filter.ts's catch-all for the other
// half, a defense-in-depth backstop for anything that still isn't a
// well-formed UUID by the time it reaches the DB): THIS helper is the
// primary fix, called as the FIRST statement of every :id-path-param
// handler, before any DB touch (including resolveViewer()).
//
// Mission spec / STATE.md's invisible == nonexistent posture (byte-
// identical 404s — see problem.exception.ts's notFound() doc comment)
// means a malformed id must be indistinguishable from a syntactically
// valid-but-nonexistent one: 404, not 400, using the SAME fixed detail
// string the route's own notFound() calls already use for "really wasn't
// there" / "there but invisible to this viewer" — so all three cases
// produce byte-identical (modulo `instance`) problem+json bodies.
//
// This is a plain function, not a Nest PipeTransform: a @Param pipe's
// `transform(value, metadata)` has no access to the Request object
// (ArgumentMetadata carries no request reference), so it cannot build
// `instance` the way every other notFound() call site in this codebase
// does (req.originalUrl / sanitizeInstancePath(req) — see
// sanitize-instance.ts's header) without resorting to request-scoped DI
// for a single validation check. Calling this explicitly as the first line
// of the handler keeps the call site symmetric with every other guard
// check these controllers already do (requireAdmin(req), etc.) instead of
// introducing a second, heavier mechanism for this one thing.

import { notFound } from "./problem.exception.js";

// Matches Postgres's own `uuid` input format (RFC 4122 8-4-4-4-12 hex, any
// version/variant octet) — Postgres's uuid column doesn't enforce a
// specific version, and neither does this schema, which uses UUIDv7
// elsewhere (CLAUDE.md invariant 5).
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Throws the SAME 404 problem+json a real "not found or not visible"
 * result would (see this file's header) when `value` is not a
 * syntactically valid UUID. Call this FIRST in the handler, before any DB
 * touch — `detail`/`instance` should be exactly what the same handler's
 * own notFound() call(s) already use for the nonexistent-id case, so the
 * two responses are byte-identical apart from `instance`.
 */
export function requireUuidParam(value: string, detail: string, instance: string): void {
  if (!isValidUuid(value)) {
    throw notFound(detail, instance);
  }
}
