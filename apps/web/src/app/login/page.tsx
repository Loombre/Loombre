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
//   - FORGOT?: OMITTED. No password-reset endpoint exists
//     (packages/contract/openapi.yaml has no such path).
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
// csp/auth logic is untouched: handleSubmit below is byte-identical to the
// pre-retheme version.
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
import { LoombreClient, LoombreApiError } from "@loombre/sdk";
import { Button } from "../../components/ui/Button.js";
import { TextInput } from "../../components/ui/Input.js";
import { BlazeMark } from "../../components/brand/BlazeMark.js";
import { buildDeviceProfile } from "../../lib/device-profile.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { defaultServerUrlGuess, describeServerUrl } from "../../lib/server-url.js";
import { ServerIndicator } from "./ServerIndicator.js";
import styles from "./page.module.css";

const SERVER_URL_KEY = "loombre.onboarding.serverUrl";

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

  useEffect(() => {
    const store = getAuthStore();
    if (store.isAuthenticated()) {
      router.replace("/home");
      return;
    }
    const remembered = window.localStorage.getItem(SERVER_URL_KEY);
    const resolved = remembered ?? (store.getSnapshot().serverUrl || defaultServerUrlGuess());
    setServerUrl(resolved);
    if (!describeServerUrl(resolved)) setShowServerField(true);
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
      router.replace("/home");
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

  return (
    <div className={styles.page}>
      <div className={styles.brand}>
        <BlazeMark variant="gradient" size={56} />
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
        {error && <div className={styles.error}>{error}</div>}
        <Button type="submit" variant="primary" className={styles.submit} disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
        <div className={styles.footnote}>Credentials never leave your network · no cloud account</div>
      </form>
    </div>
  );
}
