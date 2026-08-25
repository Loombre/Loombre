// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/settings/MailCredentialsCard.tsx
//
// E5/M10 (Optional Mail Transport run): write-only SMTP username/password
// card — the ProviderKeysCard.tsx pattern (task spec: "ProviderKeysCard.tsx
// is the pattern") adapted from "one row per provider" to "one row, two
// fields" (username + password are ONE keyring entry, PUT/DELETE
// /admin/mail/credentials, not a per-field write). Same three-state
// machine, same security posture: idle -> "Set"/"Replace" + "Clear" (idle
// -> replacing -> Save/Cancel; idle -> confirming -> Clear/Cancel), NEVER
// prefilled (GET /admin/settings' mailCredentials field carries only
// configured/setAtMs/source — there is no value to prefill from, by
// construction), env-pinned rows render locked/read-only with no editor at
// all (LOOMBRE_SMTP_USERNAME/LOOMBRE_SMTP_PASSWORD, checked together since
// the server pins the pair as a unit).
//
// UNLIKE provider keys, credentials are OPTIONAL overall (E5: "credentials
// OPTIONAL — unauthenticated SMTP relays are legal") — "not configured" is
// a legitimate steady state, not merely "not set yet", so the idle copy
// says so rather than implying something is missing.

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { apiDelete, apiPut } from "../../../lib/api-client.js";
import type { components } from "@loombre/sdk";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./MailCredentialsCard.module.css";

type MailCredentialsStatus = components["schemas"]["MailCredentialsStatus"];

type Mode = "idle" | "replacing" | "confirming";

export function MailCredentialsCard({
  status,
  onChanged,
}: {
  status: MailCredentialsStatus;
  onChanged: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>("idle");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const envLocked = status.source === "env";
  const canClear = status.configured && !envLocked;
  const canSave = username.trim().length > 0 && password.length > 0;

  function resetToIdle(): void {
    setMode("idle");
    setUsername("");
    setPassword("");
    setError(null);
  }

  async function handleSave(): Promise<void> {
    if (!canSave) {
      setError("Username and password are both required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPut("/admin/mail/credentials", { body: { username, password } });
      // Draft cleared BEFORE returning to idle — same security discipline
      // as ProviderKeysCard.tsx's handleSet (see that file's header): the
      // typed value must never sit in local state a render longer than it
      // has to.
      resetToIdle();
      onChanged();
    } catch (err) {
      setError(apiErrorCopy(err, "Failed to save credentials."));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await apiDelete("/admin/mail/credentials");
      resetToIdle();
      onChanged();
    } catch (err) {
      setError(apiErrorCopy(err, "Failed to clear credentials."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.title}>SMTP credentials</h2>
        <span className={styles.sectionMeta}>WRITE-ONLY · OPTIONAL</span>
      </div>
      <p className={styles.helpText}>
        Only needed if your mail provider requires authentication — an unauthenticated relay on your own network is
        a legal configuration. Once saved, the username and password are never shown or returned again by this or
        any other endpoint.
      </p>

      {envLocked ? (
        <div className={styles.lockedDisplay}>
          <Icon icon="lock" size="dense" aria-label="Locked" />
          <span>
            Set by environment (<span className={styles.envVar}>LOOMBRE_SMTP_USERNAME</span> /{" "}
            <span className={styles.envVar}>LOOMBRE_SMTP_PASSWORD</span>). Never editable here.
          </span>
        </div>
      ) : mode === "replacing" ? (
        <div className={styles.replaceRow}>
          <TextInput
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            autoFocus
          />
          <TextInput
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
          />
          <div className={styles.replaceActions}>
            <Button variant="primary" onClick={() => void handleSave()} disabled={saving || !canSave}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={resetToIdle} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      ) : mode === "confirming" ? (
        <div className={styles.confirmBlock}>
          <span className={styles.confirmText}>Clear the stored SMTP credentials?</span>
          <div className={styles.confirmActions}>
            <Button variant="danger" onClick={() => void handleClear()} disabled={saving}>
              {saving ? "Clearing…" : "Clear"}
            </Button>
            <Button variant="ghost" onClick={resetToIdle} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.idleRow}>
          <div className={styles.statusRow}>
            <span className={styles.statusPill} data-set={status.configured}>
              {status.configured ? "CONFIGURED" : "NOT CONFIGURED"}
            </span>
            {status.configured && status.source && (
              <span className={styles.sourcePill}>{status.source === "env" ? "ENVIRONMENT" : "KEYRING"}</span>
            )}
            {status.setAtMs !== null && status.setAtMs !== undefined && (
              <span className={styles.lastSet}>SET {new Date(status.setAtMs).toLocaleString()}</span>
            )}
          </div>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => setMode("replacing")}>
              <Icon icon={KeyRound} size="dense" />
              {status.configured ? "Replace credentials" : "Set credentials"}
            </Button>
            {canClear && (
              <Button variant="ghost" className={styles.removeButton} onClick={() => setMode("confirming")}>
                Clear
              </Button>
            )}
          </div>
        </div>
      )}
      {error && <p className={styles.errorText}>{error}</p>}
    </section>
  );
}
