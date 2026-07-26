// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/server-url.ts
//
// "Which server should this browser talk to before any auth state exists"
// heuristic — same-origin, standard port 3001. Used by the login page's
// server-url field default AND by the STATE.md P4.6 boot-wiring check
// (AuthStore.checkNeedsSetup(), apps/web/src/app/page.tsx / app/setup's own
// guard): both need a best-guess origin before a user has ever typed one
// in. Pure/no side effects beyond reading `window.location` — safe to call
// from a module that must stay import-cycle-free with api-client.ts (see
// auth-store.ts's own header for why THAT file never imports api-client.ts).

export function defaultServerUrlGuess(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.protocol}//${window.location.hostname}:3001`;
}

/** Login screen's server-indicator pill (Phosphor H1 retheme,
 *  design/phosphor/dc:2640-2643): the prototype's fixture reads
 *  "LOOMBRE-01 · 192.168.1.40:3001 · TLS · 2 MS" — a server NAME and a
 *  round-trip LATENCY, neither of which this app has any mechanism to
 *  produce (no server-discovery/naming concept, no ping/health-latency
 *  probe anywhere in lib/). Rather than fabricate them, the pill shows only
 *  what a URL genuinely tells you: host[:port] and whether the scheme is
 *  TLS. Pure/no side effects so the login page's render logic and this
 *  file's own test can share it without a DOM. Returns null for an empty or
 *  unparseable string (first-run state, or a value still mid-edit) so the
 *  caller can fall back to a neutral placeholder instead of showing
 *  "null:null". */
export interface ServerUrlSummary {
  host: string;
  tls: boolean;
}

export function describeServerUrl(serverUrl: string): ServerUrlSummary | null {
  const trimmed = serverUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) return null;
    return { host: parsed.host, tls: parsed.protocol === "https:" };
  } catch {
    return null;
  }
}
