// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/credential-endpoints.ts
//
// Deliberately its OWN module, separate from api-client.ts — same reason
// api-error-message.ts is (see that file's header): api-client.ts is
// vi.mock()'d wholesale by dozens of component tests, and any new export
// on it throws "No <x> export is defined on the mock." in every one of
// them.
//
// What it decides: whether api-client's reactive-401 retry may fire.
// That retry exists because a 401 normally means "your access token went
// stale" — refresh once, resend. On an endpoint that VALIDATES A
// SUBMITTED CREDENTIAL the same 401 means "the secret you just sent is
// wrong", and resending it is both useless and harmful: QA
// browser-restricted-settings-F2 found one typed wrong PIN producing TWO
// POST /restricted/unlock calls, so each attempt burned two of the
// server's five-per-minute unlock attempts and the user got only two real
// tries before "Too many attempts".

/**
 * `"<METHOD> <path template>"` for every endpoint that validates a
 * credential carried in the request itself. The path is the SDK path
 * template exactly as passed to apiPost/apiPut/apiPatch (`{id}`
 * placeholders unexpanded), not the resolved URL.
 *
 * - `POST /restricted/unlock` — 401 "Incorrect PIN." (the F2 case).
 * - `POST /auth/login` / `POST /auth/refresh` — 401 "Invalid credentials." /
 *   "Invalid, expired, or reused refresh token." Both are reached through
 *   the raw client today (auth-store.ts, login/page.tsx) rather than these
 *   wrappers; listed so that stays true by construction if a caller ever
 *   switches.
 * - the current-password re-auth endpoints — a wrong `currentPassword`
 *   answers 403 `current-password-invalid` today, so their 401s are
 *   guard-only and still retried (see below); listed so a future move to
 *   401 cannot silently resurrect the double-submit.
 */
const CREDENTIAL_VALIDATION_ENDPOINTS: ReadonlySet<string> = new Set([
  "POST /restricted/unlock",
  "POST /auth/login",
  "POST /auth/refresh",
  "PATCH /users/me",
  "PUT /users/me/restricted",
  "POST /users/{id}/reset-password",
]);

/** The AuthGuard's problem type for a missing/expired/invalid Bearer token
 *  (apps/server/src/gateway/unauthenticated.exception.ts). Kept as a
 *  literal rather than imported — apps/web never imports from apps/server. */
const UNAUTHENTICATED_PROBLEM_TYPE = "urn:loombre:problem:unauthenticated";

/** True when the caught error's RFC 9457 body says the request never got
 *  past the auth guard — i.e. the token, not the submitted credential, is
 *  what failed. Duck-typed (like apiErrorMessage) so it reads a real
 *  LoombreApiError and a test's stand-in alike. A 401 with no/unparsed
 *  problem body is deliberately NOT claimed either way here. */
function isStaleTokenProblem(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const problem = (error as { problem?: unknown }).problem;
  if (problem === null || typeof problem !== "object") return false;
  return (problem as { type?: unknown }).type === UNAUTHENTICATED_PROBLEM_TYPE;
}

/**
 * May api-client refresh the access token and resend this request after a
 * 401?
 *
 * Everything outside the credential list keeps the blanket retry. On a
 * credential endpoint the retry survives only for a 401 the auth guard
 * itself raised (`urn:loombre:problem:unauthenticated`) — a stale token
 * there means the credential was never even evaluated, so one refresh and
 * one resend is exactly right, and dropping that would tell a user with a
 * revoked session that their CORRECT PIN was wrong. Anything else on
 * those paths (the handler's own "Incorrect PIN." / "Invalid
 * credentials.", or a 401 with no problem body) is a credential verdict:
 * surface it once, resend nothing.
 */
export function shouldRetryAfterUnauthorized(method: string, path: string, error: unknown): boolean {
  if (!CREDENTIAL_VALIDATION_ENDPOINTS.has(`${method.toUpperCase()} ${path}`)) return true;
  return isStaleTokenProblem(error);
}
