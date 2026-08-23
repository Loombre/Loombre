// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/auth-return-path.ts
//
// browser-shell-browse-F1 (2026-08-20/21 QA, P2): the return-path half of
// "any terminal auth failure routes to /login and tears the splash down".
// A session that dies on /browse?library=… should come back to
// /browse?library=… after signing in again — not to /home, and definitely
// not to whatever a crafted `?next=` says.
//
// Its own module (not a helper inside api-client.ts) for the reason the
// lane log records: api-client.ts is `vi.mock`'d wholesale by ~34 component
// tests, so every new export there breaks them ("No <x> export is defined
// on the mock"); api-error-message.ts set the precedent.
//
// Everything here is a pure string function except the three explicitly
// window-reading helpers at the bottom — same split the rest of lib/ uses
// (relocation-nudge.ts), so the interesting logic is unit-testable without
// a DOM.

/** Query parameter carrying the post-sign-in destination. */
export const RETURN_PATH_PARAM = "next";

/** How long AppShell waits for `router.replace('/login')` to actually
 *  commit before giving up on client-side navigation and doing a full
 *  document load. QA's trigger was an intermittent Next-dev render/compile
 *  stall that swallowed the replace: the app must not sit on a dead screen
 *  waiting for a navigation that is never going to arrive. Long enough
 *  that a healthy client-side route change (unmounting this component,
 *  which clears the timer) always wins the race. */
export const AUTH_REDIRECT_FALLBACK_MS = 2_500;

/** Route prefixes a return path may never point at. Sending someone back
 *  to an auth entry point after signing in is at best a no-op bounce and
 *  at worst a redirect loop (/login → /login → …). */
const NON_RETURNABLE_PREFIXES = ["/login", "/setup", "/forgot", "/reset", "/claim"];

/** Belt-and-braces cap: a return path is a path within this app, not a
 *  payload. */
const MAX_RETURN_PATH_LENGTH = 512;

/**
 * Narrow an untrusted `?next=` value down to a same-origin, in-app path we
 * are willing to navigate to, or `null`.
 *
 * The open-redirect rules matter because this value is attacker-supplied by
 * construction (anyone can send a link to `/login?next=…`): only a path is
 * ever accepted — never an absolute URL, never a scheme-relative `//host`
 * (which a browser resolves to a DIFFERENT ORIGIN), never a backslash
 * variant (`/\host`, which several browsers normalise to `//host`), and
 * never anything carrying control characters or whitespace that could be
 * used to smuggle one of those past this check.
 */
export function sanitizeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_RETURN_PATH_LENGTH) return null;
  // Must be an absolute-path reference, and only that.
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value.includes("\\")) return null;
  // Control characters and raw spaces — including the \t\n\r a browser
  // STRIPS from a URL before resolving it, which is how "/\t/evil.host"
  // slips past a naive startsWith("//") check. A genuine return path
  // never contains them: it comes from `location.pathname +
  // location.search`, which the browser hands back percent-encoded.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(value)) return null;

  const pathname = value.split(/[?#]/, 1)[0] ?? "";
  for (const prefix of NON_RETURNABLE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return null;
  }
  return value;
}

/**
 * The /login href to send a viewer to when their session is gone.
 * `currentPath` is where they were; an unusable one just yields a bare
 * `/login` (never a broken or half-encoded query).
 */
export function buildLoginHref(currentPath: string | null | undefined): string {
  const target = sanitizeReturnPath(currentPath);
  if (target === null) return "/login";
  return `/login?${RETURN_PATH_PARAM}=${encodeURIComponent(target)}`;
}

/** `?next=` out of a `location.search`-shaped string, sanitized. */
export function readReturnPathFromSearch(search: string | null | undefined): string | null {
  if (typeof search !== "string" || search.length === 0) return null;
  return sanitizeReturnPath(new URLSearchParams(search).get(RETURN_PATH_PARAM));
}

/** Where the viewer is right now, path + query, or null outside a browser. */
export function currentLocationPath(): string | null {
  if (typeof window === "undefined") return null;
  return `${window.location.pathname}${window.location.search}`;
}

/** The current page's sanitized `?next=`, or null. */
export function readReturnPathFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return readReturnPathFromSearch(window.location.search);
}

/** Full document navigation — the deliberate escape hatch for when the
 *  client-side router has stopped committing (see AUTH_REDIRECT_FALLBACK_MS).
 *  Wrapped because jsdom (and any environment without real navigation)
 *  throws on `location.assign`, and a failed fallback must never take the
 *  page down with it — the on-screen link is still there. */
export function hardRedirect(href: string): void {
  if (typeof window === "undefined") return;
  try {
    window.location.assign(href);
  } catch {
    // Nothing further to try; the rendered /login link remains the manual path out.
  }
}
