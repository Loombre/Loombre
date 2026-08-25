// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/setup/_components/WelcomeStep.tsx
//
// Confirms/edits the server address before anything else — the exact same
// bootstrapping question apps/web/src/app/login/page.tsx already solves
// (same-origin:3001 guess, editable), reused here because the wizard has
// the identical "no serverUrl in the store yet" problem on a truly fresh
// browser.
//
// d3-d3 (browser-shell-browse-F2 spillover): "Get started" used to write
// the typed value straight into the AUTH STORE. That slot means "the server
// this device's tokens are valid against" (auth-store.ts's setServerUrl
// comment) — an UNPROVEN string does not belong in it. The consequence was
// the F2 trap one screen earlier: a mistyped address persisted through
// reloads, and ../page.tsx's own self-guard resolves GET /setup/state
// against exactly that value and fails CLOSED, so /setup bounced to /login
// forever with no way back except clearing localStorage.
//
// So the step now does what /login does: remember the CHOICE in
// lib/server-url-preference.ts (a UI memory — always safe to write, and the
// only value a viewer can correct without signing in), then PROVE the
// address before promoting it, here by the one public, single-boolean call
// the wizard is entitled to make (GET /setup/state — the same probe
// AuthStore.checkNeedsSetup makes on boot). A server that answers
// needsSetup:true is a Loombre instance this wizard can actually
// provision; nothing else is adopted, and the viewer finds out on THIS
// screen instead of two steps later at "Create the admin account".

import { useEffect, useState, type FormEvent } from "react";
import { Flame } from "lucide-react";
import { LoombreClient } from "@loombre/sdk";
import { Icon } from "../../../components/icon/Icon.js";
import { Button } from "../../../components/ui/Button.js";
import { TextInput } from "../../../components/ui/Input.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import { describeServerUrl } from "../../../lib/server-url.js";
import {
  rememberPreferredServerUrl,
  resolvePublicServerUrl,
} from "../../../lib/server-url-preference.js";
import styles from "./steps.module.css";

export interface WelcomeStepProps {
  onNext: () => void;
}

export function WelcomeStep({ onNext }: WelcomeStepProps): React.JSX.Element {
  const [serverUrl, setServerUrl] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Same order every public page resolves: the viewer's committed choice
    // first (it is the only one they can correct while signed out), then an
    // established session's server, then the same-origin guess.
    setServerUrl(resolvePublicServerUrl(getAuthStore().getSnapshot().serverUrl));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const candidate = serverUrl.trim();
    setError(null);
    setChecking(true);
    // The choice is remembered whether or not the probe succeeds: this
    // field, and /login's pill, must come back showing what the viewer
    // typed, or a typo is invisible and uncorrectable.
    rememberPreferredServerUrl(candidate);

    try {
      const client = new LoombreClient({
        // No /v1 segment — see api-client.ts's header (the contract's
        // `servers` entry vs. what the server actually mounts).
        baseUrl: candidate.replace(/\/$/, ""),
        getAccessToken: () => null,
      });
      const state = await client.get("/setup/state");
      if (state.needsSetup !== true) {
        setError("That server is already set up — go back and sign in instead.");
        return;
      }
      // Proven: a Loombre instance answered, and it still needs setup. Only
      // now does the store learn about it — every later step (AdminStep's
      // POST /setup/first-admin through to the authenticated ones) reads it
      // from there.
      getAuthStore().setServerUrl(candidate);
      onNext();
    } catch {
      const host = describeServerUrl(candidate)?.host ?? candidate;
      setError(`Could not reach a Loombre server at ${host}. Check the address and try again.`);
    } finally {
      setChecking(false);
    }
  }

  return (
    <form className={styles.step} onSubmit={(e) => void handleSubmit(e)}>
      <div className={styles.iconBadge} aria-hidden="true">
        <Icon icon={Flame} />
      </div>
      <h1 className={styles.title}>Welcome to Loombre</h1>
      <p className={styles.body}>
        Let&apos;s get your server ready. In a few minutes you&apos;ll create the first admin
        account, point Loombre at your media, and confirm your hardware is ready for playback.
      </p>
      <label className={styles.field} htmlFor="setup-server-url">
        <span className={styles.label}>Server address</span>
        <TextInput
          id="setup-server-url"
          type="url"
          required
          autoComplete="url"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
        />
        <span className={styles.hint}>Guessed from this page&apos;s address — change it if your server runs elsewhere.</span>
      </label>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.actionsEnd}>
        <Button type="submit" variant="primary" disabled={checking}>
          {checking ? "Checking…" : "Get started"}
        </Button>
      </div>
    </form>
  );
}
