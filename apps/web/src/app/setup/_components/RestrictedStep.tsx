// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/setup/_components/RestrictedStep.tsx
//
// GET /system/capabilities (STATE.md P1.19: LOOMBRE_RESTRICTED_ENABLED is an
// ENV-level instance flag — there is no instance-settings table, per this
// lane's constraints; this step can only INFORM the operator about the env
// var, never flip it) + optionally PUT /users/me/restricted (the EXISTING
// self-service opt-in/PIN endpoint — no admin-on-behalf-of path exists,
// which is fine here since the wizard's caller IS the admin). Mirrors
// apps/web/src/app/settings/page.tsx's RestrictedSection UI pattern.

import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { LoombreApiError } from "@loombre/sdk";
import { Icon } from "../../../components/icon/Icon.js";
import { Button } from "../../../components/ui/Button.js";
import { TextInput } from "../../../components/ui/Input.js";
import { SegmentedControl } from "../../../components/ui/SegmentedControl.js";
import { apiGet, apiPut } from "../../../lib/api-client.js";
import { PIN_LENGTH, isPinComplete, sanitizePinInput } from "../../../lib/pin-entry.js";
import { deriveRestrictedViewState } from "../wizard-state.js";
import styles from "./steps.module.css";

export interface RestrictedStepProps {
  onNext: () => void;
}

export function RestrictedStep({ onNext }: RestrictedStepProps): React.JSX.Element {
  const [capabilityEnabled, setCapabilityEnabled] = useState<boolean | null>(null);
  const [optIn, setOptIn] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet("/system/capabilities")
      .then((caps) => {
        if (cancelled) return;
        setCapabilityEnabled(caps.details["restricted-content"]?.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setCapabilityEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (!optIn) {
      onNext();
      return;
    }
    if (!isPinComplete(pin)) {
      setError(`Enter a ${PIN_LENGTH}-digit PIN to enable restricted content.`);
      return;
    }
    setSubmitting(true);
    try {
      await apiPut("/users/me/restricted", { body: { optIn: true, pin } });
      onNext();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  if (capabilityEnabled === null) {
    return (
      <div className={styles.step}>
        <div className={styles.iconBadge} aria-hidden="true">
          <Icon icon={ShieldCheck} />
        </div>
        <h2 className={styles.subtitle}>Restricted content</h2>
        <p className={styles.body}>Checking instance capabilities…</p>
      </div>
    );
  }

  const view = deriveRestrictedViewState(capabilityEnabled);

  return (
    <div className={styles.step}>
      <div className={styles.iconBadge} aria-hidden="true">
        <Icon icon={ShieldCheck} />
      </div>
      <h2 className={styles.subtitle}>Restricted content</h2>

      {view === "capability-off" ? (
        <>
          <p className={styles.body}>
            Restricted (adult) content support is off for this instance. It&apos;s controlled by
            the <code>LOOMBRE_RESTRICTED_ENABLED</code> environment variable on the server, not by
            anything in this wizard — set it before restarting the server to enable restricted
            libraries and the per-user opt-in/PIN flow. Off is the default, matching Loombre&apos;s
            policy of never enabling this capability implicitly.
          </p>
          <div className={styles.actionsEnd}>
            <Button type="button" variant="primary" onClick={onNext}>
              Continue
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={handleSubmit} className={styles.step} noValidate>
          <p className={styles.body}>
            This instance supports restricted content. Optionally enable it for your own account
            now — unlocking never persists across logins, so you&apos;ll always re-enter the PIN
            after signing back in. You can change this anytime from Settings.
          </p>
          <div className={styles.field}>
            <span className={styles.label}>Enable for my account</span>
            <SegmentedControl
              options={["Off", "On"]}
              defaultValue="Off"
              onChange={(v) => setOptIn(v === "On")}
            />
          </div>
          {optIn && (
            <label className={styles.field} htmlFor="setup-restricted-pin">
              <span className={styles.label}>PIN ({PIN_LENGTH} digits)</span>
              <TextInput
                id="setup-restricted-pin"
                type="password"
                inputMode="numeric"
                maxLength={PIN_LENGTH}
                value={pin}
                onChange={(e) => setPin(sanitizePinInput(e.target.value))}
              />
            </label>
          )}
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.actionsEnd}>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Saving…" : "Continue"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
