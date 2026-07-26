// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/setup/_components/WelcomeStep.tsx
//
// Confirms/edits the server address before anything else — the exact same
// bootstrapping question apps/web/src/app/login/page.tsx already solves
// (same-origin:3001 guess, editable), reused here because the wizard has
// the identical "no serverUrl in the store yet" problem on a truly fresh
// browser.

import { useEffect, useState, type FormEvent } from "react";
import { Flame } from "lucide-react";
import { Icon } from "../../../components/icon/Icon.js";
import { Button } from "../../../components/ui/Button.js";
import { TextInput } from "../../../components/ui/Input.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import { defaultServerUrlGuess } from "../../../lib/server-url.js";
import styles from "./steps.module.css";

export interface WelcomeStepProps {
  onNext: () => void;
}

export function WelcomeStep({ onNext }: WelcomeStepProps): React.JSX.Element {
  const [serverUrl, setServerUrl] = useState("");

  useEffect(() => {
    const store = getAuthStore();
    setServerUrl(store.getSnapshot().serverUrl || defaultServerUrlGuess());
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    getAuthStore().setServerUrl(serverUrl);
    onNext();
  }

  return (
    <form className={styles.step} onSubmit={handleSubmit}>
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
      <div className={styles.actionsEnd}>
        <Button type="submit" variant="primary">
          Get started
        </Button>
      </div>
    </form>
  );
}
