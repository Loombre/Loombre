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
// Byte-identical-404 posture (E8/M12): GET /invites/claim/{token} (F1: the
// API's own path, distinct from this page's own /claim/[token] route)
// resolves invalid/expired/already-claimed/revoked tokens to the SAME 404
// — this screen therefore shows exactly ONE generic "isn't valid" screen
// for all four cases and never tries to guess which one applies; the
// server deliberately gives it nothing to guess from.
//
// Claim success (M13) mints a real TokenPair — applyTokenPair + redirect
// straight to /home, same as a normal login.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoombreClient, LoombreApiError } from "@loombre/sdk";
import type { components } from "@loombre/sdk";
import { AuthScreen } from "../../../components/auth/AuthScreen.js";
import { InvalidLinkScreen } from "../../../components/auth/InvalidLinkScreen.js";
import { Button } from "../../../components/ui/Button.js";
import { TextInput } from "../../../components/ui/Input.js";
import { buildDeviceProfile } from "../../../lib/device-profile.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import { resolvePublicServerUrl } from "../../../lib/server-url-preference.js";
import { apiErrorMessage, isApiProblem } from "../../../lib/api-error-message.js";
import styles from "../../../components/auth/AuthScreen.module.css";

type ClaimState = components["schemas"]["ClaimState"];

// LD-13c (STATE.md "Mail posture trio"): once signed in (M13), a claim
// whose intended email silently collided (`emailApplied: false` — see
// TokenPair's own contract description) shows ONE honest interstitial
// before handing off to /home, instead of redirecting straight there and
// leaving the new accountholder to discover the missing email later with
// no explanation. `emailApplied: true` (or, for an older/mismatched
// server build, simply absent) skips straight to /home exactly as before —
// this phase exists ONLY for the honest-signal case.
type Phase = "loading" | "invalid" | "load-error" | "ready" | "submitting" | "claimed-email-dropped";

// d3-d4 (browser-shell-browse-F2 spillover): resolvePublicServerUrl, not
// `store.serverUrl || guess`. An invite link is opened on a browser that has
// never authenticated — the case where the store is empty and the
// same-origin guess is most likely to be wrong — and the viewer's ONE way to
// say where their server is while signed out is the sign-in screen's pill,
// which that chain ignored. Order (preference → established session → guess)
// is the same one /login and /forgot resolve through.
function publicClient(): LoombreClient {
  const serverUrl = resolvePublicServerUrl(getAuthStore().getSnapshot().serverUrl);
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
      .get("/invites/claim/{token}", { params: { path: { token } } })
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
      const hasEmailPreset = claimState.emailPreset !== null;
      const trimmedEmail = email.trim();
      // LD-13b (STATE.md "Mail posture trio"): a preset-prefilled field the
      // claimant CLEARED is opt-out intent — send an explicit `null` so the
      // server drops the preset outright, rather than omitting the member
      // (which means "keep the preset" and would silently re-apply it, the
      // exact bug this item closes). With no preset there was never
      // anything to opt out of, so an empty field stays simply omitted,
      // unchanged from before.
      const emailBody = trimmedEmail ? { email: trimmedEmail } : hasEmailPreset ? { email: null } : {};
      const pair = await publicClient().post("/invites/claim/{token}", {
        params: { path: { token } },
        body: {
          ...(hasUsernamePreset ? {} : { username }),
          password,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          ...emailBody,
          deviceName: `Loombre Web (${deviceProfile.profileId})`,
          deviceProfile,
        },
      });
      getAuthStore().applyTokenPair(pair);
      // LD-13c: already signed in either way (M13 unaffected) — only the
      // REDIRECT is gated on the honest signal, so a dropped email gets
      // one interstitial explaining why instead of vanishing silently.
      if (pair.emailApplied === false) {
        setPhase("claimed-email-dropped");
        return;
      }
      router.replace("/home");
    } catch (err) {
      if (isApiProblem(err) && err.status === 404) {
        // The token was consumed/revoked/expired between the GET above and
        // this submit — same byte-identical-404 posture, same screen.
        setPhase("invalid");
        return;
      }
      setPhase("ready");
      if (isApiProblem(err)) {
        setError(apiErrorMessage(err, "Could not claim this invite. Try again."));
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
    // LD-15 (rc.6): the layout/treatment now lives in the shared
    // InvalidLinkScreen, which /reset/[token] renders too — this screen's
    // own wording is unchanged, only its markup moved.
    return (
      <InvalidLinkScreen
        heading="This invite link isn't valid"
        body="It may be expired, already used, or mistyped — ask whoever sent it for a new one."
        actionLabel="Go to sign in"
        onAction={() => router.push("/login")}
      />
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

  if (phase === "claimed-email-dropped") {
    return (
      <AuthScreen tagline="Your media. Your hardware. Your rules.">
        <p className={styles.formHeading}>Account created</p>
        <p className={styles.bodyText}>
          You&apos;re signed in — but the email address on this invite is already in use by another account
          here, so it wasn&apos;t added to yours. Add a different one anytime from Settings.
        </p>
        <Button type="button" variant="primary" className={styles.submit} onClick={() => router.replace("/home")}>
          Continue
        </Button>
      </AuthScreen>
    );
  }

  const submitting = phase === "submitting";
  const usernameLocked = claimState?.usernamePreset !== null && claimState?.usernamePreset !== undefined;
  const hasEmailPreset = claimState?.emailPreset !== null && claimState?.emailPreset !== undefined;

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
          {/* LD-13b: a preset-prefilled field the claimant clears is sent as
              an explicit `email: null` opt-out (see handleSubmit above),
              not silently re-defaulted to the preset — this hint is what
              tells them clearing it actually does something. No preset,
              nothing to opt out of, so no hint. */}
          {hasEmailPreset && <span className={styles.hint}>Pre-filled from your invite — clear this to skip it.</span>}
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
