// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/RemoteEnrollStepBody.tsx
//
// STATE.md "Loombre Remote ..." (R2/R3, Lane U2's mission item 2) — the
// QR CEREMONY: pick a user + device name -> POST
// /admin/remote/wireguard/devices -> the ONE-TIME provisioning payload
// (RemoteWireguardEnrollment{device, configText}, packages/shared/src/
// remote/provisioning.ts's own wire format). This is packages/shared/src/
// remote/wizard-state.ts's LAST step of PATH_FLOW_STEPS.remote — completing
// it advances the wizard straight to the "proof" stage (R6).
//
// MEMORY-ONLY (mission's own hard line): `configText` lives in this
// component's own `useState` ONLY — no state manager, no localStorage/
// sessionStorage (this app deliberately has zero sessionStorage usage,
// STATE.md's own NG10 precedent). It is never written anywhere durable;
// unmounting this component (Continue's onStepComplete triggers
// PathFlowStage's step swap, which unmounts this whole function component)
// discards it via ordinary React garbage collection. See
// RemoteEnrollStepBody.test.tsx's dedicated assertion.
//
// HONEST 501 (WG2 not landed — see RemoteEnableStepBody.tsx's header for
// the same finding against this lane's actual base): the enrollment POST
// itself is what the mission names explicitly ("Endpoint 501s (WG2 not
// landed): honest 'not available on this build' state").

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { SecretReveal } from "../../ui/SecretReveal.js";
import { QrCode } from "../../ui/QrCode.js";
import { apiGet, apiPost, LoombreApiError } from "../../../lib/api-client.js";
import type { PathFlowStepBodyProps } from "./path-flow-step-types.js";
import styles from "./RemoteEnrollStepBody.module.css";

type User = components["schemas"]["User"];
type RemoteWireguardEnrollment = components["schemas"]["RemoteWireguardEnrollment"];

type Phase = "loadingUsers" | "form" | "enrolling" | "unavailable" | "revealed";

/** Filesystem-safe filename derived from the device label — lowercase,
 *  non-alphanumeric runs collapsed to a single hyphen, trimmed. Falls back
 *  to "device" if the name is entirely punctuation/whitespace. */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "device";
}

export function RemoteEnrollStepBody({ onStepComplete, onBack }: PathFlowStepBodyProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("loadingUsers");
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<RemoteWireguardEnrollment | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadUsers(): Promise<void> {
      try {
        const page = await apiGet("/users", { params: { query: { limit: 200 } } });
        if (cancelled) return;
        setUsers(page.items);
        setUserId(page.items[0]?.id ?? "");
        setPhase("form");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof LoombreApiError ? err.message : "Failed to load users.");
        setPhase("form");
      }
    }
    void loadUsers();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleEnroll(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!userId || deviceName.trim().length === 0) {
      setError("Pick a user and name the device.");
      return;
    }
    setPhase("enrolling");
    setError(null);
    try {
      const res = await apiPost("/admin/remote/wireguard/devices", { body: { userId, name: deviceName.trim() } });
      setEnrollment(res);
      setPhase("revealed");
    } catch (err) {
      if (err instanceof LoombreApiError && err.status === 501) {
        setPhase("unavailable");
        return;
      }
      setError(err instanceof LoombreApiError ? err.message : "Failed to enroll this device.");
      setPhase("form");
    }
  }

  function handleDownload(): void {
    if (!enrollment) return;
    const blob = new Blob([enrollment.configText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeFilename(enrollment.device.name)}.conf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (phase === "loadingUsers") {
    return (
      <div className={styles.step} role="status">
        <p className={styles.stepTitle}>Enroll your first device</p>
        <p className={styles.body}>Loading users…</p>
      </div>
    );
  }

  if (phase === "unavailable") {
    return (
      <div className={styles.step} role="status">
        <p className={styles.stepTitle}>Enroll your first device</p>
        <p className={styles.unavailable}>Enrolling a device isn't available on this build yet.</p>
      </div>
    );
  }

  if (phase === "revealed" && enrollment) {
    return (
      <div className={styles.step}>
        <p className={styles.stepTitle}>{enrollment.device.name} is ready</p>
        <p className={styles.warningText}>
          This is shown once — scanning later means re-enrolling. Loombre does not retain the private key after this
          screen closes.
        </p>

        <div className={styles.revealRow}>
          <QrCode value={enrollment.configText} label={`WireGuard configuration for ${enrollment.device.name}`} />
          <div className={styles.revealSide}>
            <SecretReveal
              label="Configuration"
              value={enrollment.configText}
              multiline
              warning="This is shown once — scanning later means re-enrolling."
            />
            <Button type="button" variant="secondary" onClick={handleDownload}>
              Download .conf
            </Button>
          </div>
        </div>

        <p className={styles.body}>
          Open the WireGuard app on {enrollment.device.name}, add a tunnel, and either scan this QR code or import the
          downloaded .conf file.
        </p>

        <label className={styles.confirmRow}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>I've added it to the device</span>
        </label>

        <div className={styles.stepActions}>
          <Button type="button" variant="primary" onClick={() => onStepComplete()} disabled={!confirmed}>
            Continue
          </Button>
        </div>
      </div>
    );
  }

  // phase === "form" | "enrolling"
  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Enroll your first device</p>
      <p className={styles.body}>Pick who this device belongs to and give it a name — it'll get its own key and a stable address.</p>

      <form className={styles.form} onSubmit={(e) => void handleEnroll(e)}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>User</span>
          <select className={styles.select} value={userId} onChange={(e) => setUserId(e.target.value)} disabled={phase === "enrolling"}>
            {users.length === 0 && <option value="">No users found</option>}
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName ?? u.username}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Device name</span>
          <TextInput
            placeholder="e.g. Alex's iPhone"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            disabled={phase === "enrolling"}
          />
        </label>

        {error && <p className={styles.errorText}>{error}</p>}

        <div className={styles.stepActions}>
          {onBack && (
            <Button type="button" variant="ghost" onClick={onBack} disabled={phase === "enrolling"}>
              Back
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={phase === "enrolling" || users.length === 0}>
            {phase === "enrolling" ? "Enrolling…" : "Enroll device"}
          </Button>
        </div>
      </form>
    </div>
  );
}
