// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/reset/[token]/ResetPasswordScreen.tsx
//
// E3b/E8/M12/M16: the public self-serve reset-password completion screen.
// Split out of page.tsx for the same reason ClaimScreen.tsx is split out
// of /claim/[token]/page.tsx — see that file's header.
//
// LD-15 (rc.6): this screen now PROBES the token at page load, exactly as
// /claim does. It previously could not: the contract had only POST
// /auth/reset-password, whose validation IS the token's consume, so the
// form was shown unconditionally and a dead link only surfaced after the
// viewer had typed a new password twice and submitted. GET
// /auth/reset-password/{token} is the read-only twin added for this — a
// pure liveness read that consumes nothing — so a dead link now shows the
// SHARED InvalidLinkScreen before the form is ever offered.
//
// Three deliberate properties of that probe:
//   * 404 (invalid, expired, already-used, unknown — all byte-identical
//     per E8/M12) is the ONLY thing that renders "isn't valid". Any other
//     failure renders a DISTINCT load-error screen, because an unreachable
//     server must never read to the viewer as a dead token.
//   * The submit-time 404 guard below STAYS. The probe precedes it, it
//     does not replace it: a token used, expired, or superseded between
//     the GET and the POST still lands on the same invalid screen.
//   * Both requests resolve their server through resolvePublicServerUrl
//     (the module-level publicClient() below) — a probe aimed at the
//     same-origin guess would call a perfectly live link dead.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoombreClient } from "@loombre/sdk";
import { AuthScreen } from "../../../components/auth/AuthScreen.js";
import { InvalidLinkScreen } from "../../../components/auth/InvalidLinkScreen.js";
import { Button } from "../../../components/ui/Button.js";
import { TextInput } from "../../../components/ui/Input.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import { resolvePublicServerUrl } from "../../../lib/server-url-preference.js";
import { apiErrorMessage, isApiProblem } from "../../../lib/api-error-message.js";
import styles from "../../../components/auth/AuthScreen.module.css";

type Phase = "loading" | "form" | "submitting" | "success" | "invalid" | "load-error";

// d3-d4 (browser-shell-browse-F2 spillover): resolvePublicServerUrl, not
// `store.serverUrl || guess`. A reset link is opened on a browser with no
// session — exactly where the store is empty and the same-origin guess is
// most likely wrong — and the pill on /login is the only place a signed-out
// viewer can correct it. Same order /login and /forgot resolve through.
// LD-15 (rc.6): hoisted out of handleSubmit to a module-level helper, the
// shape ClaimScreen.tsx already uses, now that there are two call sites
// (the page-load probe and the submit).
function publicClient(): LoombreClient {
  const serverUrl = resolvePublicServerUrl(getAuthStore().getSnapshot().serverUrl);
  return new LoombreClient({ baseUrl: serverUrl.replace(/\/$/, ""), getAccessToken: () => null });
}

export function ResetPasswordScreen({ token }: { token: string }): React.JSX.Element {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    publicClient()
      .get("/auth/reset-password/{token}", { params: { path: { token } } })
      .then(() => {
        if (cancelled) return;
        setPhase("form");
      })
      .catch((err) => {
        if (cancelled) return;
        if (isApiProblem(err) && err.status === 404) setPhase("invalid");
        else setPhase("load-error");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setPhase("submitting");
    try {
      await publicClient().post("/auth/reset-password", { body: { token, password } });
      setPhase("success");
    } catch (err) {
      if (isApiProblem(err) && err.status === 404) {
        // The token was used, expired, or superseded between the page-load
        // probe and this submit — same byte-identical-404 posture, same
        // screen. The probe never made this guard redundant.
        setPhase("invalid");
        return;
      }
      setPhase("form");
      if (isApiProblem(err)) {
        setError(apiErrorMessage(err, "Could not reset your password. Try again."));
      } else {
        setError("Could not reach the server. Check your connection and try again.");
      }
    }
  }

  if (phase === "loading") {
    return (
      <AuthScreen>
        <p className={styles.bodyText}>Checking your reset link…</p>
      </AuthScreen>
    );
  }

  if (phase === "invalid") {
    // LD-15 (rc.6): the shared dead-link screen /claim renders too — the
    // wording here is unchanged, only its markup moved.
    return (
      <InvalidLinkScreen
        heading="This reset link isn't valid"
        body="It may be expired, already used, or mistyped — request a new one from the sign-in page."
        actionLabel="Request a new link"
        onAction={() => router.push("/forgot")}
      />
    );
  }

  if (phase === "load-error") {
    // Deliberately DISTINCT from "invalid" (the same split /claim makes):
    // a network failure must never read to the viewer as a dead token, or
    // they'd abandon a link that is perfectly good.
    return (
      <AuthScreen>
        <p className={styles.formHeading}>Couldn&apos;t check this reset link</p>
        <p className={styles.bodyText}>Check your connection and try again.</p>
        <Button type="button" variant="secondary" className={styles.submit} onClick={() => window.location.reload()}>
          Try again
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
