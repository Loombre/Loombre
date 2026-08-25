// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/api-error-message.ts
//
// Deliberately its OWN module, separate from api-client.ts: the client is
// mocked wholesale by dozens of component tests (vi.mock("../lib/api-
// client")), and any consumer of a client export that those mocks don't
// re-declare throws "No <x> export is defined on the mock." This pure,
// dependency-light helper lives here so components can import it without
// every one of those mocks having to know about it. It duck-types the
// error shape rather than importing LoombreApiError, so it is correct
// whether it sees a real LoombreApiError or a test's fake stand-in.

/**
 * Best user-facing text for a caught API error: the RFC 9457 problem
 * `detail` (the server's specific, actionable sentence — e.g. "set the
 * WireGuard endpoint host from Settings before enrolling a device") when
 * present, else the error's title-level `message`, else the caller's
 * fallback. Prefer this over `err.message` in every catch that shows the
 * user an error — bare `.message` surfaces only the generic status title
 * ("Unprocessable Entity", "Conflict") and drops the detail the server
 * went to the trouble of writing (V-UX F2/F3).
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err !== null && typeof err === "object") {
    const problem = (err as { problem?: unknown }).problem;
    if (problem !== null && typeof problem === "object") {
      const detail = (problem as { detail?: unknown }).detail;
      if (typeof detail === "string" && detail.length > 0) return detail;
    }
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

/** A caught error carrying evidence that the server ANSWERED. `status` is
 *  optional in the TYPE only because a problem-document-only error is still
 *  an answer; every `LoombreApiError` has one. */
export interface ApiProblemError {
  readonly status?: number;
  readonly problem?: unknown;
}

/**
 * True when the server answered at all, false when the request never got
 * there (an offline browser, a wrong host, a DNS failure — `fetch` rejects
 * with a bare `TypeError`, which carries no status).
 *
 * This is the OTHER half of the `instanceof LoombreApiError` migration
 * (d4-e6). Several catch blocks branch on the class not to read copy but to
 * choose between the server's own sentence and "Could not reach the server"
 * — a distinction worth keeping, since blaming a viewer's connection for an
 * answer the server actually sent is its own lie. `instanceof` is the wrong
 * test for it for the same reason it was the wrong test for the copy: an
 * error that crossed a module boundary, was re-thrown, or came from a second
 * copy of the SDK is a server answer that fails the class check. Duck-type
 * the status instead, then hand the value to `apiErrorMessage`.
 *
 * Either signal counts, and no transport failure carries either: a numeric
 * `status` (every `LoombreApiError` has one — including for a body that was
 * not a problem document at all, where `problem` is null), or a problem
 * document on its own (the same field `apiErrorMessage` reads, so the two
 * helpers agree about what an answer looks like).
 */
export function isApiProblem(err: unknown): err is ApiProblemError {
  if (err === null || typeof err !== "object") return false;
  if (typeof (err as { status?: unknown }).status === "number") return true;
  const problem = (err as { problem?: unknown }).problem;
  return typeof problem === "object" && problem !== null;
}

/**
 * The user-facing sentence for a caught API error: what the SERVER said when
 * the server answered, and the caller's own fallback when it did not. This
 * is the default for any catch that renders an error to a person.
 *
 * It is `apiErrorMessage` with the transport case closed off, and that
 * difference is the entire reason it exists (d4-e6). The idiom this replaced
 * — narrow to `LoombreApiError`, render its message, else the fallback —
 * had two branches for a reason: a `fetch` that never reached the host rejects with
 * a bare `TypeError`, and `apiErrorMessage` would faithfully render its
 * `.message`, so a viewer with no network reads "Failed to fetch" or
 * "network down" where the surface's hand-written sentence belongs. Routing
 * those sites through `apiErrorMessage` alone therefore fixes the class
 * check and quietly breaks the copy; this keeps both halves right.
 *
 * Use `apiErrorMessage` directly only for a value already known to be an
 * answer, or where a non-API `Error`'s own message IS the copy (a locally
 * thrown, user-facing validation error — setup/_components/RestoreStep.tsx
 * is the live example, and it branches explicitly).
 */
export function apiErrorCopy(err: unknown, fallback: string): string {
  return isApiProblem(err) ? apiErrorMessage(err, fallback) : fallback;
}
