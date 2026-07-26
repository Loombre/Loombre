// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/libraries/ProviderChainEditor.tsx
//
// Lane W5b: the admin Libraries page's provider-chain editor (mission
// item 1) — opened from a "Provider chain" button on each library row,
// mirroring PermissionsModal's own per-row-modal convention in
// app/admin/libraries/page.tsx exactly. GET/PUT
// /admin/libraries/{id}/provider-chain around lib/library-provider-chain.ts's
// pure state helpers (this component owns ONLY `entries: ChainDraftEntry[]`
// in React state — every mutation, drag-drop or keyboard-button-driven,
// calls one of that module's pure functions).
//
// Interaction model:
//   - `isDefault:true` (no rows yet): entries render READ-ONLY (no drag
//     handle, no move/remove buttons) with a note explaining these are
//     Loombre's built-in default for this library's mediaKind, plus a
//     "Customize this chain" button. Nothing is written until Save.
//   - Clicking "Customize this chain" (or, for an ALREADY-customized
//     chain, immediately on open) makes every row interactive: an HTML5
//     native drag reorder (draggable + dragstart/dragover/drop — zero new
//     deps, no drag library) with keyboard-accessible up/down buttons as
//     the SAME underlying moveEntry primitive's fallback path, a remove
//     button per row, and add-entry pickers below (native <select>s,
//     eligible choices ONLY — builtins always eligible, plugins filtered
//     server-side to this library's OWN contentClass, LPP C5 STRICT).
//   - Save (PUT, explicit — never autosaved) persists `entries` wholesale;
//     an empty list clears the chain and reverts to isDefault:true.
//     Cancel discards local edits and, if nothing was ever saved, returns
//     to the read-only default view.

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, X } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Modal } from "../Modal.js";
import { Button } from "../../ui/Button.js";
import { Tag } from "../../ui/Chip.js";
import { Icon } from "../../icon/Icon.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import {
  addBuiltinEntry,
  addPluginEntry,
  draftFromEntries,
  moveEntry,
  moveEntryDown,
  moveEntryUp,
  removeEntryAt,
  toWireEntries,
  type ChainDraftEntry,
} from "../../../lib/library-provider-chain.js";
import { apiGet, apiPut, LoombreApiError } from "../../../lib/api-client.js";
import styles from "./ProviderChainEditor.module.css";

type Library = components["schemas"]["Library"];
type AdminLibraryProviderChain = components["schemas"]["AdminLibraryProviderChain"];

export function ProviderChainModal({ library, onClose }: { library: Library; onClose: () => void }): React.JSX.Element {
  const [chain, setChain] = useState<AdminLibraryProviderChain | null>(null);
  const [original, setOriginal] = useState<ChainDraftEntry[]>([]);
  const [entries, setEntries] = useState<ChainDraftEntry[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [addBuiltinChoice, setAddBuiltinChoice] = useState("");
  const [addPluginChoice, setAddPluginChoice] = useState("");

  useEffect(() => {
    apiGet("/admin/libraries/{id}/provider-chain", { params: { path: { id: library.id } } })
      .then((res) => {
        setChain(res);
        const draft = draftFromEntries(res.entries);
        setOriginal(draft);
        setEntries(draft);
        setEditing(!res.isDefault);
      })
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load this library's provider chain."));
  }, [library.id]);

  function applyResponse(res: AdminLibraryProviderChain): void {
    setChain(res);
    const draft = draftFromEntries(res.entries);
    setOriginal(draft);
    setEntries(draft);
    setEditing(!res.isDefault);
  }

  function handleCancel(): void {
    setEntries(original);
    setEditing(chain ? !chain.isDefault : false);
    setError(null);
  }

  function handleDrop(targetIndex: number): void {
    if (dragIndex === null) return;
    setEntries((prev) => moveEntry(prev, dragIndex, targetIndex));
    setDragIndex(null);
  }

  function handleAddBuiltin(): void {
    if (!addBuiltinChoice) return;
    setEntries((prev) => addBuiltinEntry(prev, addBuiltinChoice));
    setAddBuiltinChoice("");
  }

  function handleAddPlugin(): void {
    if (!addPluginChoice || !chain) return;
    const plugin = chain.eligiblePlugins.find((p) => p.id === addPluginChoice);
    if (!plugin) return;
    setEntries((prev) => addPluginEntry(prev, plugin));
    setAddPluginChoice("");
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await apiPut("/admin/libraries/{id}/provider-chain", {
        params: { path: { id: library.id } },
        body: { entries: toWireEntries(entries) },
      });
      applyResponse(res);
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to save this provider chain.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Provider chain — ${library.name}`} onClose={onClose}>
      <div className={styles.wrap}>
        {error && <p className={styles.errorText}>{error}</p>}

        {!chain ? (
          <div className={styles.skeletonList} aria-hidden="true">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} radius="md" height={44} />
            ))}
          </div>
        ) : (
          <>
            {!editing && (
              <p className={styles.note}>
                This library doesn&apos;t have a provider chain of its own yet — the order below is Loombre&apos;s
                built-in default for {library.mediaKind} libraries, applied automatically. Customize it to reorder,
                add, or remove providers just for this library; nothing changes until you save.
              </p>
            )}

            <ol className={styles.list}>
              {entries.map((entry, index) => (
                <li
                  key={entry.key}
                  className={styles.row}
                  draggable={editing}
                  onDragStart={() => editing && setDragIndex(index)}
                  onDragOver={(e) => {
                    if (editing) e.preventDefault();
                  }}
                  onDrop={() => editing && handleDrop(index)}
                >
                  {editing && (
                    <span className={styles.dragHandle}>
                      <Icon icon={GripVertical} size="dense" aria-hidden />
                    </span>
                  )}
                  <span className={styles.position}>{index + 1}</span>
                  <Tag>{entry.providerKind}</Tag>
                  <span className={styles.entryLabel}>{entry.label}</span>
                  {editing && (
                    <div className={styles.rowActions}>
                      <Button
                        variant="ghost"
                        iconOnly
                        onClick={() => setEntries((prev) => moveEntryUp(prev, index))}
                        disabled={index === 0}
                        title="Move up"
                      >
                        <Icon icon={ChevronUp} size="dense" aria-label={`Move "${entry.label}" up`} />
                      </Button>
                      <Button
                        variant="ghost"
                        iconOnly
                        onClick={() => setEntries((prev) => moveEntryDown(prev, index))}
                        disabled={index === entries.length - 1}
                        title="Move down"
                      >
                        <Icon icon={ChevronDown} size="dense" aria-label={`Move "${entry.label}" down`} />
                      </Button>
                      <Button variant="ghost" iconOnly onClick={() => setEntries((prev) => removeEntryAt(prev, index))} title="Remove">
                        <Icon icon={X} size="dense" aria-label={`Remove "${entry.label}"`} />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
              {entries.length === 0 && <li className={styles.empty}>No providers in this chain.</li>}
            </ol>

            {!editing ? (
              <div className={styles.actions}>
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  Customize this chain
                </Button>
              </div>
            ) : (
              <>
                <div className={styles.addRow}>
                  <select
                    className={styles.select}
                    value={addBuiltinChoice}
                    onChange={(e) => setAddBuiltinChoice(e.target.value)}
                    aria-label="Add a built-in provider"
                  >
                    <option value="">Add a built-in provider…</option>
                    {chain.builtinProviderNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <Button variant="secondary" onClick={handleAddBuiltin} disabled={!addBuiltinChoice}>
                    Add
                  </Button>
                </div>
                <div className={styles.addRow}>
                  <select
                    className={styles.select}
                    value={addPluginChoice}
                    onChange={(e) => setAddPluginChoice(e.target.value)}
                    disabled={chain.eligiblePlugins.length === 0}
                    aria-label="Add a plugin"
                  >
                    <option value="">{chain.eligiblePlugins.length === 0 ? "No eligible plugins for this library" : "Add a plugin…"}</option>
                    {chain.eligiblePlugins.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.enabled ? "" : " (disabled)"}
                      </option>
                    ))}
                  </select>
                  <Button variant="secondary" onClick={handleAddPlugin} disabled={!addPluginChoice}>
                    Add
                  </Button>
                </div>

                <div className={styles.actions}>
                  <Button variant="ghost" onClick={handleCancel} disabled={saving}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
