// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/server-url-preference.ts
//
// "Which server did the viewer CHOOSE on the sign-in screen" — the login
// pill's own memory, kept deliberately separate from the auth store's
// `serverUrl` ("which server did we last successfully authenticate
// against"). browser-shell-browse-F2 (2026-08-20/21 QA, P2) is what
// happens when those two are the same slot: login's handleSubmit wrote the
// typed URL into loombre.auth.v1 BEFORE the request, so a single failed
// attempt against a wrong URL (http://localhost:9) replaced the working
// one for the whole app — surviving full reloads, because the auth store
// re-reads localStorage on every construction — and /forgot, which
// resolves the same value, kept POSTing at the dead server even after the
// pill had been corrected back.
//
// The split:
//   - auth store `serverUrl`  → written only once an auth SUCCEEDS
//     (login/page.tsx). Authenticated request paths (api-client.ts,
//     events-socket.ts, media URLs) read it, and must: it is where the
//     tokens in that same store are actually valid.
//   - this preference key     → written when the viewer COMMITS a choice
//     on the sign-in screen (the server editor's Done, or a submit). It is
//     a UI memory, not a credential, so a failed attempt writing it is
//     harmless: the pill shows exactly that value on the next load, so
//     what the viewer sees and what the public pages post to agree.
//
// Public, pre-auth pages resolve through `resolvePublicServerUrl()` — the
// preference first, since that is the value the sign-in screen displays and
// the only one the viewer can correct without signing in. Keep this module
// a leaf: it imports server-url.ts (itself pure) and nothing else, so
// auth-store.ts and api-client.ts could both use it without an import
// cycle.

import { defaultServerUrlGuess } from "./server-url.js";

/** localStorage key. Named for the onboarding-lite flow that introduced it
 *  (login/page.tsx's "remember where to connect"); the name is load-bearing
 *  — it is already on real devices, so it stays. */
export const SERVER_URL_PREFERENCE_KEY = "loombre.onboarding.serverUrl";

/** The server URL the sign-in screen last committed, or null when there is
 *  none (never set, blank, or no `window` — SSR/prerender). Blank is
 *  deliberately null rather than "": an empty remembered value must fall
 *  through to the next candidate, not win and leave the pill empty. */
export function readPreferredServerUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SERVER_URL_PREFERENCE_KEY);
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    // Private-mode / disabled storage: behave as "nothing remembered".
    return null;
  }
}

/** Remember a server URL the viewer COMMITTED on the sign-in screen. A
 *  blank value clears the memory rather than storing "" (see the read
 *  above). Never called with a half-typed value — only on the server
 *  editor's Done and on submit. */
export function rememberPreferredServerUrl(serverUrl: string): void {
  if (typeof window === "undefined") return;
  const trimmed = serverUrl.trim();
  try {
    if (trimmed === "") window.localStorage.removeItem(SERVER_URL_PREFERENCE_KEY);
    else window.localStorage.setItem(SERVER_URL_PREFERENCE_KEY, trimmed);
  } catch {
    // Storage unavailable — the in-page state is still correct for this
    // navigation; nothing here is worth failing a sign-in over.
  }
}

/**
 * Which server a PUBLIC (pre-auth) page should talk to: /login's own
 * bootstrap, /forgot, and anything else reachable without a session.
 *
 * Order — viewer's committed choice, then the established session's
 * server, then the same-origin guess. The preference wins because it is the
 * value the sign-in screen SHOWS: after browser-shell-browse-F2 a viewer
 * who fixes the pill must be able to fix these pages with it, without
 * signing in first. `established` is the auth store's `serverUrl`, passed
 * in rather than read here so this module stays free of the auth store.
 */
export function resolvePublicServerUrl(established: string): string {
  return readPreferredServerUrl() ?? (established.trim() || defaultServerUrlGuess());
}
