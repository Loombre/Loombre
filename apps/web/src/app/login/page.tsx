// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/login/page.tsx
//
// Phosphor H1 retheme (design/phosphor/README.md via
// design/phosphor/Loombre Phosphor.dc.html dc:2632-2663 — "LOGIN"): radial
// amber-glow background, pulsing brand dot, LOOMBRE wordmark, a
// server-indicator pill with a SWITCH affordance, the sign-in form, and the
// existing error-banner behavior. ONE responsive tree (U2) — no separate
// mobile branch, CSS reflows the same markup at 767.98px.
//
// Ground truth (U9 — every prototype fixture checked against a real
// capability before being wired or omitted):
//   - Server pill: the prototype fixture reads "LOOMBRE-01 · 192.168.1.40
//     :3001 · TLS · 2 MS" — a server NAME and round-trip LATENCY. Neither
//     exists: there is no server-discovery/naming concept anywhere in this
//     app, and nothing measures request latency. lib/server-url.ts's new
//     `describeServerUrl` reports only what a URL genuinely tells you
//     (host[:port], TLS from the scheme) — name and latency are simply
//     absent, not faked. The "SWITCH" affordance is real: it discloses the
//     actual `serverUrl` field this form already posts with, per the fix
//     brief ("the prototype's separate pill+switch UX replacing the
//     visible input; keep the actual input reachable via the switch
//     state") — nothing was removed, the pill is just the default view.
//   - Trust-this-device checkbox: OMITTED. No "trusted device" concept
//     exists anywhere in auth-store.ts or the /auth/login contract — a
//     checkbox that changes nothing on submit would be a dead control
//     (U9).
//   - FORGOT?: Lane D (Optional Mail Transport run) closes this — GET
//     /system/capabilities now carries `passwordResetAvailable` (M8: true
//     iff mail is configured with host/from-address/public-URL all set).
//     The link is fetched and shown ONLY when that flag is true, per that
//     schema field's own doc comment ("the login screen shows a forgot
//     password affordance only when this is true") — see the new
//     useEffect below. This comment is intentionally left in place (rather
//     than deleted) as the historical record of the earlier omission.
//   - "Use a passkey": OMITTED. No WebAuthn/passkey support exists
//     anywhere in this codebase.
//   - "FIRST RUN? SET UP THIS SERVER →": OMITTED. /setup exists as a real
//     route, but this screen has no way to know server-provisioned state
//     up front, and the app already auto-redirects an unprovisioned/
//     cleared session straight to /setup (STATE.md's redirect-honesty
//     note) — a manual link here would be redundant on a fresh server and
//     actively misleading on an already-provisioned one.
//   - "CREDENTIALS NEVER LEAVE YOUR NETWORK · NO CLOUD ACCOUNT": kept —
//     this is a true architectural statement (direct browser-to-your-
//     server connection, no relay), the same kind of factual claim as the
//     About tab's "GROUND-UP. NOT A FORK. NO TELEMETRY." — not a fixture
//     value.
//
// csp/auth logic was byte-identical to the pre-retheme version as of the
// last retheme lane; Lane D (Optional Mail Transport run, M14) makes the
// first real functional change to handleSubmit since — TokenPair now
// additively carries `mustChangePassword`, and while it's true the server
// restricts the account to auth routes + GET /users/me + PATCH /users/me
// (a password change) until cleared. The session IS valid (M14: "the
// current session is valid") — this page does not throw the token away or
// treat it as a failed login; it stores it and renders a minimal
// must-change screen (below) BEFORE ever reaching /home. The server
// enforces the lockdown; this is the honest UX for it.
//
// G10 (STATE.md "Current-password re-auth on self-changes"): that PATCH
// now dependentRequires `currentPassword` alongside `password` — same rule
// as every other self-service password change. The must-change screen's
// "Temporary password" field supplies it — a genuine re-entry, not
// auto-filled from the `password` state above even though that value is
// sitting right there: this is a real re-authentication gate (the exact
// same "prove you still hold the secret" property every other currentPassword
// field on this app asks for), not busywork to route around. The copy just
// says plainly that it IS the value they signed in with seconds ago, so
// re-typing it reads as confirmation rather than confusion.
//
// STATE.md "Blaze logo rollout" G1 (Lane B owns this surface): the
// pulsing accent-colored dot (class + keyframes now deleted; identifiers
// not named here — the brand:pulse-dot gate bans them, comments included)
// was the OTHER placeholder pulse-dot G1's recon found (Sidebar's is Lane
// A's, D8) — replaced with the D2 stacked-lockup treatment: a real <BlazeMark>
// above the existing wordmark, composed markup rather than a lockup SVG
// (D2's Google-Fonts-@import ban). Wordmark keeps its .24em letter-spacing
// but gains the .24em optical padding-left the D2 stacked convention
// requires, and its weight moves 900 -> var(--weight-black) (800) per the
// recorded weight-800-over-900 law (W3 fidelity-audit conflict 5: build
// follows the README, not the earlier retheme's guess).

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LoombreClient, LoombreApiError } from "@loombre/sdk";
import { Button } from "../../components/ui/Button.js";
import { TextInput } from "../../components/ui/Input.js";
import { BlazeMark } from "../../components/brand/BlazeMark.js";
import blazeIdle from "../../components/brand/BlazeIdle.module.css";
import { buildDeviceProfile } from "../../lib/device-profile.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { defaultServerUrlGuess, describeServerUrl } from "../../lib/server-url.js";
// apiPatch (not a plain LoombreClient call): mustChangePassword's PATCH
// happens AFTER a real TokenPair is already stored (M14 — "the current
// session is valid"), so it goes through the same authenticated,
// 401-retrying wrapper every other in-app request uses, not a second raw
// public client. LoombreApiError here is the identical class api-client.js
// re-exports from @loombre/sdk — one import above already brought it in.
import { apiPatch } from "../../lib/api-client.js";
// browser-shell-browse-F1: AppShell sends a viewer whose session died on
// /browse?library=… here as `/login?next=%2Fbrowse%3Flibrary%3Dabc`. The
// reader sanitizes before returning anything (open-redirect guard — this
// value is attacker-supplied by construction), so `?? "/home"` below is
// both the no-parameter default AND the refusal path.
import { readReturnPathFromLocation } from "../../lib/auth-return-path.js";
import { ServerIndicator } from "./ServerIndicator.js";
import styles from "./page.module.css";

const SERVER_URL_KEY = "loombre.onboarding.serverUrl";

// G10 (STATE.md "Current-password re-auth on self-changes") — same check as
// AccountSection.tsx's isCurrentPasswordInvalid: a wrong `currentPassword`
// 403s with `code: "current-password-invalid"` regardless of which endpoint
// prompted it (F2/G3), which is what distinguishes it from every other
// error this form already renders (a mismatch, a network failure, a 429).
function isCurrentPasswordInvalid(err: unknown): boolean {
  if (!(err instanceof LoombreApiError)) return false;
  const problem = err.problem;
  return (
    typeof problem === "object" &&
    problem !== null &&
    "code" in problem &&
    (problem as { code?: unknown }).code === "current-password-invalid"
  );
}

export default function LoginPage(): React.JSX.Element {
  const router = useRouter();
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Default view is the read-only pill (prototype default); SWITCH reveals
  // the real serverUrl input in its place. Starts open when there is
  // nothing sensible to summarize yet, so a first-ever visit never hides
  // the only way to set a server.
  const [showServerField, setShowServerField] = useState(false);
  // M8: only rendered true when GET /system/capabilities (public) says so.
  const [passwordResetAvailable, setPasswordResetAvailable] = useState(false);
  // M14: set once a login response carries mustChangePassword:true. The
  // TokenPair is already applied to the store by then (session IS valid) —
  // this just switches which form renders, it never signs the user back
  // out.
  const [mustChange, setMustChange] = useState(false);
  const [tempPassword, setTempPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [mustChangeError, setMustChangeError] = useState<string | null>(null);
  const [tempPasswordError, setTempPasswordError] = useState<string | null>(null);
  const [mustChangeSubmitting, setMustChangeSubmitting] = useState(false);

  useEffect(() => {
    const store = getAuthStore();
    if (store.isAuthenticated()) {
      router.replace(readReturnPathFromLocation() ?? "/home");
      return;
    }
    const remembered = window.localStorage.getItem(SERVER_URL_KEY);
    const resolved = remembered ?? (store.getSnapshot().serverUrl || defaultServerUrlGuess());
    setServerUrl(resolved);
    if (!describeServerUrl(resolved)) setShowServerField(true);

    // M8: a public, unauthenticated capability check — same client shape
    // handleSubmit below builds, no bearer token. Best-effort: a failed
    // fetch just leaves the Forgot-password link hidden (the safe default),
    // never blocks the rest of the page from rendering.
    if (resolved) {
      new LoombreClient({ baseUrl: resolved.replace(/\/$/, ""), getAccessToken: () => null })
        .get("/system/capabilities")
        .then((capabilities) => setPasswordResetAvailable(capabilities.passwordResetAvailable ?? false))
        .catch(() => undefined);
    }
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      window.localStorage.setItem(SERVER_URL_KEY, serverUrl);
      const store = getAuthStore();
      store.setServerUrl(serverUrl);

      const deviceProfile = await buildDeviceProfile();
      const existingDeviceId = store.getSnapshot().deviceId ?? undefined;

      const client = new LoombreClient({
        // No /v1 segment: the real server mounts controllers at bare paths
        // (see api-client.ts's header for why — contract's `servers` entry
        // vs. tested reality).
        baseUrl: serverUrl.replace(/\/$/, ""),
        getAccessToken: () => null,
      });

      const pair = await client.post("/auth/login", {
        body: {
          username,
          password,
          deviceName: `Loombre Web (${deviceProfile.profileId})`,
          deviceProfile,
          ...(existingDeviceId ? { deviceId: existingDeviceId } : {}),
        },
      });

      store.applyTokenPair(pair);
      // M14: the session is valid either way — a pending temporary-password
      // change routes to the must-change step INSTEAD of /home, it never
      // discards the token pair just applied.
      if (pair.mustChangePassword) {
        setMustChange(true);
      } else {
        router.replace(readReturnPathFromLocation() ?? "/home");
      }
    } catch (err) {
      if (err instanceof LoombreApiError) {
        setError(err.status === 401 ? "Invalid username or password." : err.message);
      } else {
        setError("Could not reach the server. Check the server URL and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMustChangeSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMustChangeError(null);
    setTempPasswordError(null);
    if (newPassword !== confirmNewPassword) {
      setMustChangeError("Passwords don't match.");
      return;
    }
    setMustChangeSubmitting(true);
    try {
      // A password change is one of the exact three routes the server
      // still allows while mustChangePassword is set (M14) — this is the
      // authenticated apiPatch wrapper, not a public client (see this
      // file's import comment). G10: currentPassword rides along, proving
      // the temporary password the user just signed in with.
      await apiPatch("/users/me", { body: { password: newPassword, currentPassword: tempPassword } });
      // Same destination the ordinary path takes — a forced password change
      // is a step in this sign-in, not a different one.
      router.replace(readReturnPathFromLocation() ?? "/home");
    } catch (err) {
      if (isCurrentPasswordInvalid(err)) {
        setTempPasswordError(err instanceof LoombreApiError ? err.message : "Current password is incorrect.");
      } else if (err instanceof LoombreApiError && err.status === 429) {
        setMustChangeError("Too many attempts. Wait a moment and try again.");
      } else {
        setMustChangeError(err instanceof LoombreApiError ? err.message : "Could not change your password. Try again.");
      }
    } finally {
      setMustChangeSubmitting(false);
    }
  }

  if (mustChange) {
    return (
      <div className={styles.page}>
        <div className={styles.brand}>
          <BlazeMark
            variant="gradient"
            size={56}
            animated
            surface="var(--color-bg)"
            classNames={{ blaze: blazeIdle.blaze!, core: blazeIdle.core! }}
          />
          <span className={styles.wordmark}>Loombre</span>
        </div>
        <form className={styles.form} onSubmit={(e) => void handleMustChangeSubmit(e)}>
          <div className={styles.formHeading}>Set a new password</div>
          <p className={styles.mustChangeNote}>
            An admin reset your password. Enter the temporary password you just signed in with, then choose a new
            one to continue — you&apos;re already signed in.
          </p>
          <label className={styles.field} htmlFor="tempPassword">
            <span className={styles.label}>Temporary password</span>
            <TextInput
              id="tempPassword"
              name="tempPassword"
              type="password"
              autoComplete="current-password"
              required
              value={tempPassword}
              onChange={(e) => setTempPassword(e.target.value)}
            />
            {tempPasswordError && <span className={styles.fieldError}>{tempPasswordError}</span>}
          </label>
          <label className={styles.field} htmlFor="newPassword">
            <span className={styles.label}>New password</span>
            <TextInput
              id="newPassword"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          <label className={styles.field} htmlFor="confirmNewPassword">
            <span className={styles.label}>Confirm new password</span>
            <TextInput
              id="confirmNewPassword"
              name="confirmNewPassword"
              type="password"
              autoComplete="new-password"
              required
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
            />
          </label>
          {mustChangeError && <div className={styles.error}>{mustChangeError}</div>}
          <Button type="submit" variant="primary" className={styles.submit} disabled={mustChangeSubmitting}>
            {mustChangeSubmitting ? "Saving…" : "Continue"}
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.brand}>
        {/* animated: two paths (outer + surface-filled core) so the shell
            and the negative-space core can burn independently — the idle
            motion from design/blaze/README.md's Motion §3. `surface` is the
            LOGIN page's background, not --color-bg-splash: the core is a
            cut-out filled with whatever sits behind it, and this page is
            --color-bg under a radial amber wash, not the splash surface. */}
        <BlazeMark
          variant="gradient"
          size={56}
          animated
          surface="var(--color-bg)"
          // Shared idle-burn hooks (components/brand/BlazeIdle.module.css)
          // rather than a per-page copy of the spec's keyframes — the setup
          // wizard uses the same ones. Non-null assertions for the reason
          // BootSplash.tsx states at its own call: noUncheckedIndexedAccess
          // types CSS-module lookups as `string | undefined`, which
          // exactOptionalPropertyTypes rejects against `blaze?: string`.
          classNames={{ blaze: blazeIdle.blaze!, core: blazeIdle.core! }}
        />
        <span className={styles.wordmark}>Loombre</span>
      </div>
      <div className={styles.tagline}>Your media. Your hardware. Your rules.</div>

      <div className={styles.serverRow}>
        <ServerIndicator
          serverUrl={serverUrl}
          showField={showServerField}
          onShowField={() => setShowServerField(true)}
          onHideField={() => setShowServerField(false)}
          onChangeServerUrl={setServerUrl}
        />
      </div>

      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.formHeading}>Sign in to this server</div>
        <label className={styles.field} htmlFor="username">
          <span className={styles.label}>Username or email</span>
          <TextInput
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className={styles.field} htmlFor="password">
          <span className={styles.label}>Password</span>
          <TextInput
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {passwordResetAvailable && (
          <Link href="/forgot" className={styles.forgotLink}>
            Forgot password?
          </Link>
        )}
        {error && <div className={styles.error}>{error}</div>}
        <Button type="submit" variant="primary" className={styles.submit} disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
        <div className={styles.footnote}>Credentials never leave your network · no cloud account</div>
      </form>
    </div>
  );
}
