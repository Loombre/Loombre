// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/RemoteEnrollCeremony.tsx
//
// STATE.md "Loombre Remote ..." (R2/R3, WG3 mission item 2: "POST-WIZARD
// ENROLLMENT ENTRY POINT ... lift the ceremony into a shared component both
// [the wizard and the admin Remote-management panel] can render"). This is
// U2's own QR CEREMONY (RemoteEnrollStepBody.tsx: pick a user + device name
// -> POST /admin/remote/wireguard/devices -> the ONE-TIME provisioning
// payload -> confirm), lifted verbatim out of that file and generalized
// away from PathFlowStepBodyProps' wizard-specific navigation shape
// (onStepComplete/onBack/path/step/context) so it can be embedded from
// TWO call sites without either one depending on wizard plumbing it
// doesn't have:
//   1. RemoteEnrollStepBody.tsx — now a thin wrapper (path-flow step slot,
//      unchanged registration in PathFlowStepSlot.tsx) that renders this
//      component with onDone={() => onStepComplete()}/onCancel={onBack}.
//   2. RemoteDevicesPanel.tsx's "Enroll a device" action (WG3, new) — opens
//      this SAME component inside a SheetOrModal, with onDone closing the
//      sheet + refreshing the device list, onCancel just closing it.
//
// MEMORY-ONLY (mission's own hard line, unchanged from U2): `configText`
// lives in this component's own `useState` ONLY — no state manager, no
// localStorage/sessionStorage. It is never written anywhere durable;
// unmounting this component (either caller's own navigation) discards it
// via ordinary React garbage collection. See RemoteEnrollStepBody.test.tsx
// (kept, still exercises this exact discipline through the wrapper) and
// RemoteEnrollCeremony.test.tsx (the panel-embedding coverage).

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { SecretReveal } from "../../ui/SecretReveal.js";
import { QrCode } from "../../ui/QrCode.js";
import { apiGet, apiPost, LoombreApiError } from "../../../lib/api-client.js";
import { apiErrorMessage } from "../../../lib/api-error-message.js";
import styles from "./RemoteEnrollCeremony.module.css";

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

export interface RemoteEnrollCeremonyProps {
  /** Called once the admin confirms they've added the device to it (the
   *  ceremony's own job is done at that point) — the caller decides what
   *  "done" means: advance the wizard to the next stage, or close a modal
   *  and refresh a device list. */
  onDone: () => void;
  /** The "leave without enrolling" action, shown on the form step only
   *  (never once enrollment has started/succeeded — there's nothing to
   *  "go back" from at that point, same as U2's original). Omit to hide
   *  the control entirely (e.g. an embedding with no prior step to return
   *  to). `| undefined` explicit (exactOptionalPropertyTypes): the wizard
   *  wrapper passes PathFlowStepBodyProps' own optional `onBack` straight
   *  through, which may itself be `undefined`. */
  onCancel?: (() => void) | undefined;
  /** Label for the onCancel button — "Back" in the wizard (the default,
   *  matching U2's original literal copy), "Cancel" in the admin panel's
   *  modal embedding. */
  cancelLabel?: string;
}

export function RemoteEnrollCeremony({ onDone, onCancel, cancelLabel = "Back" }: RemoteEnrollCeremonyProps): React.JSX.Element {
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
        setError(apiErrorMessage(err, "Failed to load users."));
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
      setError(apiErrorMessage(err, "Failed to enroll this device."));
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
        <p className={styles.stepTitle}>Enroll a device</p>
        <p className={styles.body}>Loading users…</p>
      </div>
    );
  }

  if (phase === "unavailable") {
    return (
      <div className={styles.step} role="status">
        <p className={styles.stepTitle}>Enroll a device</p>
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
          <Button type="button" variant="primary" onClick={onDone} disabled={!confirmed}>
            Continue
          </Button>
        </div>
      </div>
    );
  }

  // phase === "form" | "enrolling"
  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Enroll a device</p>
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
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={phase === "enrolling"}>
              {cancelLabel}
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
