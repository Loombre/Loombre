// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/auth-store.ts
//
// Access token lives in memory only (never persisted — a page reload always
// re-derives it via refresh). Refresh token + deviceId + serverUrl persist
// in localStorage so a returning device can rotate its own chain (P2.16)
// and the login form remembers where to connect ("onboarding-lite").
//
// Refresh is rotating (packages: RefreshTokenService) — reusing a refresh
// token revokes the whole chain, so concurrent 401s from several in-flight
// requests must trigger EXACTLY ONE POST /auth/refresh call. `refreshNow()`
// memoizes its in-flight promise (`inFlightRefresh`) so every caller during
// that window awaits the SAME network call instead of each firing its own.

import { defaultServerUrlGuess } from "./server-url.js";

const STORAGE_KEY = "loombre.auth.v1";

export interface PersistedAuth {
  serverUrl: string;
  refreshToken: string | null;
  deviceId: string | null;
}

interface AuthState extends PersistedAuth {
  accessToken: string | null;
  accessTokenExpiresAtMs: number | null;
}

export type Unsubscribe = () => void;

const EXPIRY_SKEW_MS = 30_000; // refresh 30s before actual expiry, not exactly at the edge.

function readPersisted(): PersistedAuth {
  if (typeof window === "undefined") {
    return { serverUrl: "", refreshToken: null, deviceId: null };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { serverUrl: "", refreshToken: null, deviceId: null };
    const parsed = JSON.parse(raw) as Partial<PersistedAuth>;
    return {
      serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : "",
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : null,
    };
  } catch {
    return { serverUrl: "", refreshToken: null, deviceId: null };
  }
}

function writePersisted(state: PersistedAuth): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** Minimal fetch surface the store needs — injectable for tests. */
export interface AuthFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}

interface TokenPairResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAtMs: number;
  deviceId: string;
}

export class AuthStore {
  private state: AuthState;
  private readonly listeners = new Set<() => void>();
  private inFlightRefresh: Promise<string | null> | null = null;
  private readonly fetchImpl: AuthFetch;
  // STATE.md P4.6 boot wiring — see checkNeedsSetup() below.
  private setupCheckCache: boolean | null = null;
  private inFlightSetupCheck: Promise<boolean> | null = null;

  // Default is bound to globalThis: browsers' window.fetch throws
  // "Illegal invocation" when invoked with any other receiver, and
  // `this.fetchImpl(...)` would otherwise call it with the store instance
  // as `this`. Node's/jsdom's fetch is receiver-insensitive, so unit tests
  // can't catch this — it only fails in a real browser, where it made
  // EVERY refresh attempt throw synchronously (no network call at all;
  // pre-transient-fix, the catch then clear()ed the stored credential —
  // the root cause of the mystery logouts). Same bug class as the SDK
  // client's fetch binding (packages/sdk/src/client.ts).
  constructor(fetchImpl: AuthFetch = fetch.bind(globalThis)) {
    this.fetchImpl = fetchImpl;
    const persisted = readPersisted();
    this.state = { ...persisted, accessToken: null, accessTokenExpiresAtMs: null };
  }

  getSnapshot = (): AuthState => this.state;

  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(patch: Partial<AuthState>): void {
    this.state = { ...this.state, ...patch };
    writePersisted({
      serverUrl: this.state.serverUrl,
      refreshToken: this.state.refreshToken,
      deviceId: this.state.deviceId,
    });
    for (const listener of this.listeners) listener();
  }

  /**
   * The server this device is AUTHENTICATED against — not "the server
   * somebody typed". It is persisted, survives reloads, and every
   * authenticated path (api-client.ts, events-socket.ts, media URLs) sends
   * the tokens in this same store to it, so writing an unproven URL here
   * points a live session at a server its credentials mean nothing on.
   *
   * INVARIANT (browser-shell-browse-F2, 2026-08-20/21 QA): call this only
   * once an auth has SUCCEEDED against `serverUrl` — login/page.tsx does it
   * on the TokenPair, not before the request. It used to write on submit,
   * so one failed attempt against a wrong URL poisoned the value for the
   * whole app (including the public /forgot page) until the next successful
   * sign-in. A server URL a user is merely CHOOSING belongs in
   * lib/server-url-preference.ts instead.
   *
   * KNOWN residual: app/setup/_components/WelcomeStep.tsx still writes an
   * unproven address here on its Next button (the wizard has no session to
   * prove anything with yet). Narrower blast radius — an unprovisioned
   * instance, no tokens in the store — but the same shape; logged as a
   * follow-up rather than fixed under this finding.
   */
  setServerUrl(serverUrl: string): void {
    this.setState({ serverUrl });
  }

  isAuthenticated(): boolean {
    return this.state.refreshToken !== null && this.state.deviceId !== null;
  }

  /**
   * GET /setup/state, once per store lifetime (STATE.md P4.6: "unauthenticated
   * web boot checks GET /setup/state once (cheap, cached in the auth
   * store)"). Callers: apps/web/src/app/page.tsx's boot redirect and
   * apps/web/src/app/setup/page.tsx's own self-guard — the latter usually
   * finds this already cached (the boot check ran first) and only hits the
   * network itself when a user deep-links straight to /setup.
   *
   * Memoized like refreshNow() above: every caller while a check is in
   * flight (including React StrictMode's dev-mode double-effect-invoke)
   * awaits the SAME network call rather than firing a second one.
   *
   * Fails CLOSED — returns `false` ("instance is configured, go to
   * /login") on any network error, non-2xx, or unparseable body. A
   * configured instance must never flash the wizard route because of a
   * transient failure; an unconfigured instance that's briefly
   * unreachable just shows /login, which is never a worse outcome (the
   * next boot re-checks from scratch — no stale `false` survives a page
   * reload, since a fresh AuthStore starts with `setupCheckCache = null`).
   */
  async checkNeedsSetup(): Promise<boolean> {
    if (this.setupCheckCache !== null) return this.setupCheckCache;

    if (!this.inFlightSetupCheck) {
      const serverUrl = this.state.serverUrl || defaultServerUrlGuess();
      this.inFlightSetupCheck = (async () => {
        try {
          const response = await this.fetchImpl(`${serverUrl.replace(/\/$/, "")}/setup/state`, {
            headers: { Accept: "application/json" },
          });
          if (!response.ok) return false;
          const body = (await response.json()) as { needsSetup?: unknown };
          return body.needsSetup === true;
        } catch {
          return false;
        }
      })();
    }

    const result = await this.inFlightSetupCheck;
    this.inFlightSetupCheck = null;
    this.setupCheckCache = result;
    return result;
  }

  applyTokenPair(pair: TokenPairResponse): void {
    this.setState({
      accessToken: pair.accessToken,
      accessTokenExpiresAtMs: pair.accessTokenExpiresAtMs,
      refreshToken: pair.refreshToken,
      deviceId: pair.deviceId,
    });
  }

  clear(): void {
    this.setState({
      accessToken: null,
      accessTokenExpiresAtMs: null,
      refreshToken: null,
      deviceId: null,
    });
  }

  private accessTokenIsFresh(): boolean {
    return (
      this.state.accessToken !== null &&
      this.state.accessTokenExpiresAtMs !== null &&
      this.state.accessTokenExpiresAtMs - EXPIRY_SKEW_MS > Date.now()
    );
  }

  /** Single-flight rotating refresh. Every concurrent caller (proactive
   *  expiry check, or a reactive 401) awaits the SAME in-flight promise —
   *  the refresh token is read/sent from `this.state` exactly once per
   *  network call, never re-sent per caller. */
  private async refreshNow(): Promise<string | null> {
    if (this.inFlightRefresh) return this.inFlightRefresh;

    const refreshToken = this.state.refreshToken;
    const deviceId = this.state.deviceId;
    if (!refreshToken || !deviceId || !this.state.serverUrl) {
      this.clear();
      return null;
    }

    this.inFlightRefresh = (async () => {
      try {
        const response = await this.fetchImpl(`${this.state.serverUrl.replace(/\/$/, "")}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken, deviceId }),
        });
        if (response.ok) {
          const pair = (await response.json()) as TokenPairResponse;
          this.applyTokenPair(pair);
          return pair.accessToken;
        }
        // Only a DEFINITIVE credential rejection destroys the stored refresh
        // token. 401 = this token is invalid/already-rotated (real reuse or a
        // genuinely stale token) → clearing is correct, the user must
        // re-authenticate. Anything else (429 rate-limit, 5xx, 503 during a
        // server restart/deploy) is TRANSIENT: the token is very likely still
        // valid, so we keep it and let a later call retry. Clearing here would
        // log the user out on every brief server blip — the bug this fixes
        // (found in Wave-2 browser E2E: concurrent server restarts wiped auth
        // mid-session and bounced the app to /login).
        if (response.status === 401) {
          this.clear();
        }
        return null;
      } catch {
        // Network-level failure (offline, connection refused during a restart,
        // DNS, CORS). Transient by nature — never destroy the credential; the
        // refresh token survives for the next attempt.
        return null;
      } finally {
        this.inFlightRefresh = null;
      }
    })();

    return this.inFlightRefresh;
  }

  /** Passed as `LoombreClientOptions.getAccessToken` — proactively refreshes
   *  when the cached token is within EXPIRY_SKEW_MS of expiring. */
  getAccessToken = async (): Promise<string | null> => {
    if (this.accessTokenIsFresh()) return this.state.accessToken;
    if (!this.isAuthenticated()) return null;
    return this.refreshNow();
  };

  /** Reactive 401 handling: forces a (still single-flight) refresh and
   *  returns the new token, or null if refresh itself failed (caller should
   *  treat that as a hard logout). */
  handleUnauthorized = async (): Promise<string | null> => {
    return this.refreshNow();
  };

  async logout(): Promise<void> {
    const { serverUrl, deviceId, accessToken } = this.state;
    if (serverUrl && accessToken) {
      try {
        await this.fetchImpl(`${serverUrl.replace(/\/$/, "")}/auth/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(deviceId ? { deviceId } : {}),
        });
      } catch {
        // best-effort: clear local state regardless of network outcome.
      }
    }
    this.clear();
  }
}

// One AuthStore per browser tab — but "one module-level `let`" is NOT the
// same guarantee as "one instance" under dev HMR / bundler chunk splitting:
// if this module gets re-evaluated (a duplicate module instance with its
// OWN `let singleton`), a plain module-singleton silently produces a SECOND
// AuthStore. Two stores means two independent single-flight refresh
// pipelines racing over the SAME rotating refresh token — the second one
// to fire treats the first's already-consumed token as reuse and revokes
// the whole device chain (observed as spurious refresh-clears on hard
// reload under HMR). Stashing the instance on `globalThis` under a
// version-keyed property survives module duplication: `globalThis` itself
// is never duplicated, only the module wrapper around this file is, so
// every duplicate evaluation reads/writes the exact same slot.
const GLOBAL_SLOT = "__loombre_auth_store_v1__";

interface GlobalWithAuthStore {
  [GLOBAL_SLOT]?: AuthStore;
}

/** One AuthStore per browser tab, resilient to module re-evaluation (HMR /
 *  chunk duplication) via a globalThis-stashed singleton; tests construct
 *  their own instance with `new AuthStore(mockFetch)` instead of this
 *  accessor. */
export function getAuthStore(): AuthStore {
  const g = globalThis as unknown as GlobalWithAuthStore;
  if (!g[GLOBAL_SLOT]) g[GLOBAL_SLOT] = new AuthStore();
  return g[GLOBAL_SLOT];
}
