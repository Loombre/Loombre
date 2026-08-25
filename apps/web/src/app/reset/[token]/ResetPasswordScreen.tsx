// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/reset/[token]/ResetPasswordScreen.tsx
//
// E3b/E8/M12/M16: the public self-serve reset-password completion screen.
// Split out of page.tsx for the same reason ClaimScreen.tsx is split out
// of /claim/[token]/page.tsx — see that file's header. Same self-guarding
// pattern as /claim (M16); this screen does NOT probe the token with a GET
// first (unlike /claim, there is no GET /auth/reset-password to resolve
// state from — the contract only has the POST). The form is always shown;
// a 404 on submit (invalid, expired, already-used, or unknown token — all
// byte-identical per E8/M12) routes to the SAME generic invalid-link
// treatment /claim uses, at the point the server actually tells us
// something's wrong rather than guessing up front.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoombreClient, LoombreApiError } from "@loombre/sdk";
import { AuthScreen } from "../../../components/auth/AuthScreen.js";
import { Button } from "../../../components/ui/Button.js";
import { TextInput } from "../../../components/ui/Input.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import { resolvePublicServerUrl } from "../../../lib/server-url-preference.js";
import styles from "../../../components/auth/AuthScreen.module.css";

type Phase = "form" | "submitting" | "success" | "invalid";

export function ResetPasswordScreen({ token }: { token: string }): React.JSX.Element {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("form");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setPhase("submitting");
    try {
      // d3-d4 (browser-shell-browse-F2 spillover): resolvePublicServerUrl,
      // not `store.serverUrl || guess`. A reset link is opened on a browser
      // with no session — exactly where the store is empty and the
      // same-origin guess is most likely wrong — and the pill on /login is
      // the only place a signed-out viewer can correct it. Same order
      // /login and /forgot resolve through.
      const serverUrl = resolvePublicServerUrl(getAuthStore().getSnapshot().serverUrl);
      const client = new LoombreClient({ baseUrl: serverUrl.replace(/\/$/, ""), getAccessToken: () => null });
      await client.post("/auth/reset-password", { body: { token, password } });
      setPhase("success");
    } catch (err) {
      if (err instanceof LoombreApiError && err.status === 404) {
        setPhase("invalid");
        return;
      }
      setPhase("form");
      if (err instanceof LoombreApiError) {
        setError(err.message);
      } else {
        setError("Could not reach the server. Check your connection and try again.");
      }
    }
  }

  if (phase === "invalid") {
    return (
      <AuthScreen>
        <p className={styles.formHeading}>This reset link isn&apos;t valid</p>
        <p className={styles.bodyText}>
          It may be expired, already used, or mistyped — request a new one from the sign-in page.
        </p>
        <Button type="button" variant="secondary" className={styles.submit} onClick={() => router.push("/forgot")}>
          Request a new link
        </Button>
      </AuthScreen>
    );
  }

  if (phase === "success") {
    return (
      <AuthScreen>
        <p className={styles.formHeading}>Password reset</p>
        <p className={styles.bodyText}>Your password has been changed. Sign in with your new password.</p>
        <Button type="button" variant="primary" className={styles.submit} onClick={() => router.push("/login")}>
          Go to sign in
        </Button>
      </AuthScreen>
    );
  }

  const submitting = phase === "submitting";

  return (
    <AuthScreen tagline="Your media. Your hardware. Your rules.">
      <form className={styles.form} onSubmit={handleSubmit}>
        <p className={styles.formHeading}>Set a new password</p>
        <label className={styles.field} htmlFor="password">
          <span className={styles.label}>New password</span>
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
          <span className={styles.label}>Confirm new password</span>
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
          {submitting ? "Resetting…" : "Reset password"}
        </Button>
      </form>
    </AuthScreen>
  );
}
