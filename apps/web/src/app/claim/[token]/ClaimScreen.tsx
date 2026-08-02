// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/claim/[token]/ClaimScreen.tsx
//
// E2/M12/M16: the public invite-claim screen. Split out of page.tsx (which
// Next type-checks as a ROUTE module and rejects any export beyond
// `default`/route-config — see items/[itemType]/[id]/page.tsx's own header
// for the identical reason DetailScreens.tsx exists) so this component can
// take `token` as a plain prop and be unit-tested directly, without
// exercising React's `use(params)` Suspense mechanics in a test harness
// that isn't a real Suspense boundary.
//
// Mirrors /login's self-guarding client pattern per M16 — "use client", no
// AppShell, a direct LoombreClient with no bearer token (public ops), and
// login/page.tsx's three-way error-branching template (LoombreApiError
// with a specific status vs. a network failure vs. anything else). UNLIKE
// /login and /setup, this screen does NOT bounce an already-authenticated
// viewer (M16: "an admin may open a claim link to verify it") — there is
// no isAuthenticated redirect anywhere in this file, by design, not
// omission.
//
// Byte-identical-404 posture (E8/M12): GET /claim/{token} resolves
// invalid/expired/already-claimed/revoked tokens to the SAME 404 an
// unknown route returns — this screen therefore shows exactly ONE generic
// "isn't valid" screen for all four cases and never tries to guess which
// one applies; the server deliberately gives it nothing to guess from.
//
// Claim success (M13) mints a real TokenPair — applyTokenPair + redirect
// straight to /home, same as a normal login.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoombreClient, LoombreApiError } from "@loombre/sdk";
import type { components } from "@loombre/sdk";
import { AuthScreen } from "../../../components/auth/AuthScreen.js";
import { Button } from "../../../components/ui/Button.js";
import { TextInput } from "../../../components/ui/Input.js";
import { buildDeviceProfile } from "../../../lib/device-profile.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import { defaultServerUrlGuess } from "../../../lib/server-url.js";
import styles from "../../../components/auth/AuthScreen.module.css";

type ClaimState = components["schemas"]["ClaimState"];

type Phase = "loading" | "invalid" | "load-error" | "ready" | "submitting";

function publicClient(): LoombreClient {
  const store = getAuthStore();
  const serverUrl = store.getSnapshot().serverUrl || defaultServerUrlGuess();
  return new LoombreClient({ baseUrl: serverUrl.replace(/\/$/, ""), getAccessToken: () => null });
}

export function ClaimScreen({ token }: { token: string }): React.JSX.Element {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("loading");
  const [claimState, setClaimState] = useState<ClaimState | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    publicClient()
      .get("/claim/{token}", { params: { path: { token } } })
      .then((state) => {
        if (cancelled) return;
        setClaimState(state);
        setUsername(state.usernamePreset ?? "");
        setDisplayName(state.displayNamePreset ?? "");
        setEmail(state.emailPreset ?? "");
        setPhase("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof LoombreApiError && err.status === 404) setPhase("invalid");
        else setPhase("load-error");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!claimState) return;
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setPhase("submitting");
    try {
      const deviceProfile = await buildDeviceProfile();
      const hasUsernamePreset = claimState.usernamePreset !== null;
      const pair = await publicClient().post("/claim/{token}", {
        params: { path: { token } },
        body: {
          ...(hasUsernamePreset ? {} : { username }),
          password,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          deviceName: `Loombre Web (${deviceProfile.profileId})`,
          deviceProfile,
        },
      });
      getAuthStore().applyTokenPair(pair);
      router.replace("/home");
    } catch (err) {
      if (err instanceof LoombreApiError && err.status === 404) {
        // The token was consumed/revoked/expired between the GET above and
        // this submit — same byte-identical-404 posture, same screen.
        setPhase("invalid");
        return;
      }
      setPhase("ready");
      if (err instanceof LoombreApiError) {
        setError(err.message);
      } else {
        setError("Could not reach the server. Check your connection and try again.");
      }
    }
  }

  if (phase === "loading") {
    return (
      <AuthScreen>
        <p className={styles.bodyText}>Checking your invite…</p>
      </AuthScreen>
    );
  }

  if (phase === "invalid") {
    return (
      <AuthScreen>
        <p className={styles.formHeading}>This invite link isn&apos;t valid</p>
        <p className={styles.bodyText}>
          It may be expired, already used, or mistyped — ask whoever sent it for a new one.
        </p>
        <Button type="button" variant="secondary" className={styles.submit} onClick={() => router.push("/login")}>
          Go to sign in
        </Button>
      </AuthScreen>
    );
  }

  if (phase === "load-error") {
    return (
      <AuthScreen>
        <p className={styles.formHeading}>Couldn&apos;t load this invite</p>
        <p className={styles.bodyText}>Check your connection and try again.</p>
        <Button type="button" variant="secondary" className={styles.submit} onClick={() => window.location.reload()}>
          Try again
        </Button>
      </AuthScreen>
    );
  }

  const submitting = phase === "submitting";
  const usernameLocked = claimState?.usernamePreset !== null && claimState?.usernamePreset !== undefined;

  return (
    <AuthScreen tagline="Your media. Your hardware. Your rules.">
      <form className={styles.form} onSubmit={handleSubmit}>
        <p className={styles.formHeading}>Create your account</p>
        <label className={styles.field} htmlFor="username">
          <span className={styles.label}>Username</span>
          <TextInput
            id="username"
            name="username"
            autoComplete="username"
            required
            disabled={usernameLocked}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className={styles.field} htmlFor="displayName">
          <span className={styles.label}>Display name</span>
          <TextInput
            id="displayName"
            name="displayName"
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label className={styles.field} htmlFor="email">
          <span className={styles.label}>Email (optional)</span>
          <TextInput
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className={styles.field} htmlFor="password">
          <span className={styles.label}>Password</span>
          <TextInput
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className={styles.field} htmlFor="confirmPassword">
          <span className={styles.label}>Confirm password</span>
          <TextInput
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </label>
        {error && <div className={styles.error}>{error}</div>}
        <Button type="submit" variant="primary" className={styles.submit} disabled={submitting}>
          {submitting ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthScreen>
  );
}
