// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/forgot/page.tsx
//
// E3b/E8/M12/M16: the public "forgot password" page. Same self-guarding,
// no-AppShell, direct-LoombreClient pattern as /claim (M16) — see that
// page's header. Linked from /login only when
// Capabilities.passwordResetAvailable is true (login/page.tsx's own
// change), but this ROUTE itself is not gated on that flag: a stale
// bookmark or a shared link must not become a dead end just because mail
// got unconfigured after the link was shared — the identical-202
// posture below makes that safe either way.
//
// ALWAYS the same confirmation copy on a successful submit — never branch
// on whether the identifier resolved to a real account, whether that
// account has an email on file, or whether mail is configured at all
// (E3b/E8 anti-enumeration: POST /auth/forgot-password's response body is
// byte-identical regardless). This is distinct from a genuine CLIENT-side
// failure (no network reachable at all, or the identifier was empty) —
// those carry no information about any account and are shown honestly
// rather than folded into the same copy, which would just be confusing,
// not more secure.

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { LoombreClient, LoombreApiError } from "@loombre/sdk";
import { AuthScreen } from "../../components/auth/AuthScreen.js";
import { Button } from "../../components/ui/Button.js";
import { TextInput } from "../../components/ui/Input.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { defaultServerUrlGuess } from "../../lib/server-url.js";
import styles from "../../components/auth/AuthScreen.module.css";

const CONFIRMATION_COPY =
  "If that account has an email on file and mail is configured on this server, a reset link is on its way.";

export default function ForgotPasswordPage(): React.JSX.Element {
  const [identifier, setIdentifier] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const store = getAuthStore();
      const serverUrl = store.getSnapshot().serverUrl || defaultServerUrlGuess();
      const client = new LoombreClient({ baseUrl: serverUrl.replace(/\/$/, ""), getAccessToken: () => null });
      await client.post("/auth/forgot-password", { body: { identifier } });
      // Reached ONLY after a genuine 2xx — never set proactively, so an
      // error path below can never accidentally show the confirmation.
      setSubmitted(true);
    } catch (err) {
      if (err instanceof LoombreApiError) {
        setError(err.message);
      } else {
        setError("Could not reach the server. Check your connection and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <AuthScreen>
        <p className={styles.formHeading}>Check your email</p>
        <p className={styles.bodyText}>{CONFIRMATION_COPY}</p>
        <div className={styles.linkRow}>
          <Link href="/login" className={styles.link}>
            Back to sign in
          </Link>
        </div>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen tagline="Your media. Your hardware. Your rules.">
      <form className={styles.form} onSubmit={handleSubmit}>
        <p className={styles.formHeading}>Reset your password</p>
        <p className={styles.bodyText}>Enter your username or email and, if mail is configured, we&apos;ll send a reset link.</p>
        <label className={styles.field} htmlFor="identifier">
          <span className={styles.label}>Username or email</span>
          <TextInput
            id="identifier"
            name="identifier"
            autoComplete="username"
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        </label>
        {error && <div className={styles.error}>{error}</div>}
        <Button type="submit" variant="primary" className={styles.submit} disabled={submitting}>
          {submitting ? "Sending…" : "Send reset link"}
        </Button>
        <div className={styles.linkRow}>
          <Link href="/login" className={styles.link}>
            Back to sign in
          </Link>
        </div>
      </form>
    </AuthScreen>
  );
}
