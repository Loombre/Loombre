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
