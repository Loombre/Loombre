// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/settings/ProviderKeysCard.tsx
//
// STATE.md Addendum A, decision A9 (backend: lane S1's ProviderKeysService;
// this is the UI half, lane S2) — restyled to Phosphor prototype fidelity
// and given the README's full state machine by Wave-2 lane L6
// (design/phosphor/README.md §Interactions → "Provider keys": "Idle ->
// Set or Replace + Remove. Replace reveals a password input and
// Save/Cancel. Remove requires a confirm step in a danger-tinted block.
// Copy: once saved, the value is never shown again.").
//
// SECURITY PROPERTY (test this, don't just trust it): the input is NEVER
// pre-filled with the current key — there is nothing to pre-fill it WITH;
// GET /admin/settings only ever reports set/source/lastSetMs, never the
// value, by construction on the server side (A9/AD4) — and there is no
// "reveal" affordance anywhere in this component. "Replace key" always
// starts from an empty draft, and a successful save clears the draft
// before the row returns to idle. If a future edit to this file ever
// renders `draft`/the stored value together with the idle/confirming
// state, that is the bug this header is warning you about.
//
// Three-state machine per row, independent per provider (mirrors the
// prototype's `p.idle` / `p.replacing` / `p.confirming` — never derived
// from `status`, which only ever carries idle-state facts):
//   idle       -> "Set key" (never set) or "Replace key" + "Remove" (set)
//   replacing  -> password input + Save/Cancel
//   confirming -> danger-tinted "Remove the stored <NAME> key?" + Remove/Cancel
// Env-locked rows (status.source === "env") skip the whole machine — same
// read-only display A8 uses elsewhere in this surface.

"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { apiDelete, apiPut, LoombreApiError } from "../../../lib/api-client.js";
import type { components } from "@loombre/sdk";
import styles from "./ProviderKeysCard.module.css";

type ProviderKeyStatus = components["schemas"]["ProviderKeyStatus"];
type ProviderName = components["schemas"]["ProviderName"];

const PROVIDER_LABELS: Record<ProviderName, string> = { tmdb: "TMDB", tvdb: "TVDB" };
const PROVIDER_ENV_VARS: Record<ProviderName, string> = { tmdb: "LOOMBRE_TMDB_API_KEY", tvdb: "LOOMBRE_TVDB_API_KEY" };

type RowMode = "idle" | "replacing" | "confirming";

function ProviderKeyRow({ status, onChanged }: { status: ProviderKeyStatus; onChanged: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<RowMode>("idle");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const envLocked = status.source === "env";
  const canRemove = status.set && !envLocked;

  function resetToIdle(): void {
    setMode("idle");
    setDraft("");
    setError(null);
  }

  async function handleSet(): Promise<void> {
    if (draft.trim().length === 0) {
      setError("Key must not be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPut("/admin/provider-keys/{provider}", {
        params: { path: { provider: status.provider } },
        body: { key: draft },
      });
      // Clear the draft BEFORE returning to idle — the value must never sit
      // in local state a render longer than it has to (see this file's
      // header: the never-shown-again property is a security property, not
      // a UI nicety).
      resetToIdle();
      onChanged();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to set key.");
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmRemove(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await apiDelete("/admin/provider-keys/{provider}", { params: { path: { provider: status.provider } } });
      // resetToIdle() does not touch `saving` — the `finally` below is what
      // clears it on EVERY path (success and failure alike), matching
      // handleSet()'s pattern. Without it, a successful remove would leave
      // `saving` stuck true, silently pre-disabling the confirm button the
      // next time this row re-enters "confirming".
      resetToIdle();
      onChanged();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to remove key.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowHeader}>
        <span className={styles.name}>{PROVIDER_LABELS[status.provider]}</span>
        <span className={styles.statusPill} data-set={status.set}>
          {status.set ? "SET" : "NOT SET"}
        </span>
        {status.set && (
          <span className={styles.sourcePill}>{status.source === "env" ? "ENVIRONMENT" : "KEYRING"}</span>
        )}
        {status.lastSetMs !== undefined && (
          <span className={styles.lastSet}>LAST SET {new Date(status.lastSetMs).toLocaleString()}</span>
        )}
      </div>

      {envLocked ? (
        <div className={styles.lockedDisplay}>
          <Icon icon="lock" size="dense" aria-label="Locked" />
          <span>
            Set by environment (<span className={styles.envVar}>{PROVIDER_ENV_VARS[status.provider]}</span>). Never editable here.
          </span>
        </div>
      ) : mode === "replacing" ? (
        <div className={styles.replaceRow}>
          <TextInput
            type="password"
            placeholder="Paste new key…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
            autoFocus
          />
          <div className={styles.replaceActions}>
            <Button variant="primary" onClick={() => void handleSet()} disabled={saving || draft.trim().length === 0}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={resetToIdle} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      ) : mode === "confirming" ? (
        <div className={styles.confirmBlock}>
          <span className={styles.confirmText}>Remove the stored {PROVIDER_LABELS[status.provider]} key?</span>
          <div className={styles.confirmActions}>
            <Button variant="danger" onClick={() => void handleConfirmRemove()} disabled={saving}>
              {saving ? "Removing…" : "Remove"}
            </Button>
            <Button variant="ghost" onClick={resetToIdle} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => setMode("replacing")}>
            <Icon icon={KeyRound} size="dense" />
            {status.set ? "Replace key" : "Set key"}
          </Button>
          {canRemove && (
            <Button variant="ghost" className={styles.removeButton} onClick={() => setMode("confirming")}>
              Remove
            </Button>
          )}
        </div>
      )}
      {error && <p className={styles.errorText}>{error}</p>}
    </div>
  );
}

export function ProviderKeysCard({
  statuses,
  onChanged,
}: {
  statuses: ProviderKeyStatus[];
  onChanged: () => void;
}): React.JSX.Element {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.title}>Metadata provider keys</h2>
        <span className={styles.sectionMeta}>{statuses.length} PROVIDERS · KEYS ARE WRITE-ONLY</span>
      </div>
      <p className={styles.helpText}>
        Once saved, a key's value is never shown or returned again — here or by any other endpoint. Only whether a
        key is set, its source, and when it was last set are ever reported. A newly saved key is used the next time
        Loombre restarts.
      </p>
      <div className={styles.list}>
        {statuses.map((status) => (
          <ProviderKeyRow key={status.provider} status={status} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}
