// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/LibrariesSection.tsx
//
// README tab 2 "Libraries": library rows (name, kind, item count, state,
// last scan) + a dashed "+ ADD LIBRARY" tile. Adapted from the pre-IA
// apps/web/src/app/admin/libraries/page.tsx (Phase 4 deliverable D) — same
// real endpoints (GET/POST/PATCH/DELETE /libraries, POST /libraries/{id}/
// scan, GET/PUT /libraries/{id}/permissions, GET/PUT
// /admin/libraries/{id}/provider-chain via ProviderChainEditor), restyled
// per the prototype's row shape and consolidated behind a single "⋯" menu
// (RowMenu) instead of five separate inline buttons, matching the Users &
// Profiles row's own "⋯ menu" pattern for IA consistency across this
// lane's two panes. /admin/libraries itself is now a redirect-only stub to
// /settings/libraries (this route).
//
// Derived data (never stored):
//   - Header count ("LIBRARIES · n") — libraries.length off the same GET
//     /libraries fetch this pane already makes, recomputed on every
//     render; never cached in a second piece of state (the prototype's
//     stale-subtitle lesson, README "State management").
//   - "state"/"last scan" — Library carries neither field (ground-truthed:
//     packages/contract/openapi.yaml's Library schema has no scan-state/
//     timestamp). use-library-scan-status.ts derives both LIVE from the
//     real scan.started/scan.completed websocket events (libraryId +
//     completedAtMs), session-scoped — a library this client hasn't seen
//     scan since page load shows no "last scan" text at all rather than a
//     fabricated date (U9).

import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { Tag } from "../../ui/Chip.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { EmptyState } from "../../admin/EmptyState.js";
import { Modal } from "../../admin/Modal.js";
import { ProviderChainModal } from "../../admin/libraries/ProviderChainEditor.js";
import { RowMenu } from "../RowMenu.js";
import { AddLibrarySheet } from "./AddLibrarySheet.js";
import { useLibraryScanStatus } from "./use-library-scan-status.js";
import { diffPermissionsToSubmit } from "../../../lib/library-permissions.js";
import { useToast } from "../../ui/Toast.js";
import { TextInput } from "../../ui/Input.js";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, LoombreApiError } from "../../../lib/api-client.js";
import styles from "./shared.module.css";

type Library = components["schemas"]["Library"];
type User = components["schemas"]["User"];

function formatRelativeTime(ms: number, nowMs: number): string {
  const deltaS = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (deltaS < 60) return "just now";
  const deltaMin = Math.round(deltaS / 60);
  if (deltaMin < 60) return `${deltaMin} min ago`;
  const deltaH = Math.round(deltaMin / 60);
  if (deltaH < 24) return `${deltaH}h ago`;
  const deltaD = Math.round(deltaH / 24);
  return `${deltaD}d ago`;
}

function EditLibraryModal({
  library,
  onClose,
  onUpdated,
}: {
  library: Library;
  onClose: () => void;
  onUpdated: (lib: Library) => void;
}): React.JSX.Element {
  const [name, setName] = useState(library.name);
  const [pathsText, setPathsText] = useState(library.paths.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const paths = pathsText.split("\n").map((p) => p.trim()).filter(Boolean);
    try {
      const updated = await apiPatch("/libraries/{id}", { params: { path: { id: library.id } }, body: { name, paths } });
      onUpdated(updated);
      onClose();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to update library.");
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Edit "${library.name}"`} onClose={onClose}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Paths (one per line)</span>
          <textarea className={styles.textarea} value={pathsText} onChange={(e) => setPathsText(e.target.value)} rows={3} required />
        </label>
        {error && <p className={styles.errorText}>{error}</p>}
        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PermissionsModal({ library, onClose }: { library: Library; onClose: () => void }): React.JSX.Element {
  const [allUsers, setAllUsers] = useState<User[] | null>(null);
  const [originallyGranted, setOriginallyGranted] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([
      apiGet("/users", { params: { query: { limit: 200 } } }),
      apiGet("/libraries/{id}/permissions", { params: { path: { id: library.id } } }),
    ])
      .then(([usersPage, permissionSet]) => {
        setAllUsers(usersPage.items);
        const granted = new Set(permissionSet.permissions.filter((p) => p.granted).map((p) => p.userId));
        setOriginallyGranted(granted);
        setChecked(new Set(granted));
      })
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load permissions."));
  }, [library.id]);

  function toggle(userId: string): void {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function handleSave(): Promise<void> {
    setSubmitting(true);
    setError(null);
    const entries = diffPermissionsToSubmit(originallyGranted, checked);
    try {
      await apiPut("/libraries/{id}/permissions", { params: { path: { id: library.id } }, body: { libraryId: library.id, permissions: entries } });
      onClose();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to save permissions.");
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Permissions — ${library.name}`} onClose={onClose}>
      {library.contentClass === "restricted" && (
        <p className={styles.note}>
          This is a restricted library (docs/PLAN.md §6.4&apos;s five-gate model). Granting access below is gate 4
          only — it does NOT by itself unlock content for anyone.
        </p>
      )}
      {error && <p className={styles.errorText}>{error}</p>}
      {!allUsers ? (
        <div className={styles.userChecklist} aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} radius="sm" height={32} />
          ))}
        </div>
      ) : (
        <div className={styles.userChecklist}>
          {allUsers.map((user) => (
            <label key={user.id} className={styles.checklistRow}>
              <input type="checkbox" checked={checked.has(user.id)} onChange={() => toggle(user.id)} />
              <span>{user.username}</span>
              {user.isAdmin && <Tag>admin</Tag>}
            </label>
          ))}
        </div>
      )}
      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="primary" onClick={() => void handleSave()} disabled={submitting || !allUsers}>
          {submitting ? "Saving…" : "Save"}
        </Button>
      </div>
    </Modal>
  );
}

function LibraryRow({
  library,
  scanStatus,
  onScan,
  onEdit,
  onPermissions,
  onProviderChain,
  onDelete,
}: {
  library: Library;
  scanStatus: { scanning: boolean; lastCompletedAtMs: number | null } | undefined;
  onScan: (full: boolean) => void;
  onEdit: () => void;
  onPermissions: () => void;
  onProviderChain: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>{library.name}</span>
          <span className={styles.rowSub}>{library.paths.join(", ")}</span>
        </div>
      </div>
      <div className={styles.rowChips}>
        <Tag>{library.mediaKind}</Tag>
        {library.contentClass === "restricted" && <Tag>restricted</Tag>}
        {library.itemCount != null && <span className={styles.countMono}>{library.itemCount} items</span>}
      </div>
      <div className={styles.rowEnd}>
        {scanStatus?.scanning ? (
          <span className={styles.liveBadge}>
            <span className={styles.liveDot} aria-hidden="true" />
            Scanning
          </span>
        ) : scanStatus?.lastCompletedAtMs != null ? (
          <span className={styles.rowSub}>Last scan {formatRelativeTime(scanStatus.lastCompletedAtMs, Date.now())}</span>
        ) : null}
        <RowMenu
          label={`Manage ${library.name}`}
          actions={[
            { label: "Scan", onSelect: () => onScan(false) },
            { label: "Full rescan", onSelect: () => onScan(true) },
            { label: "Permissions", onSelect: onPermissions },
            { label: "Provider chain", onSelect: onProviderChain },
            { label: "Edit", onSelect: onEdit },
            { label: "Delete", onSelect: onDelete, danger: true },
          ]}
        />
      </div>
    </div>
  );
}

export function LibrariesSection({ heading }: { heading: string | null }): React.JSX.Element {
  const { showToast } = useToast();
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Library | null>(null);
  const [managingPermissions, setManagingPermissions] = useState<Library | null>(null);
  const [managingProviderChain, setManagingProviderChain] = useState<Library | null>(null);
  const scanStatuses = useLibraryScanStatus();

  function reload(): void {
    apiGet("/libraries", { params: { query: { limit: 200 } } })
      .then((page) => setLibraries(page.items))
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load libraries."));
  }

  useEffect(reload, []);

  async function handleScan(lib: Library, full: boolean): Promise<void> {
    try {
      await apiPost("/libraries/{id}/scan", { params: { path: { id: lib.id } }, body: { full } });
      showToast(`${full ? "FULL RESCAN" : "SCAN"} STARTED — ${lib.name.toUpperCase()}`);
    } catch (err) {
      showToast(err instanceof LoombreApiError ? err.message : "Failed to start scan.", { variant: "danger" });
    }
  }

  async function handleDelete(lib: Library): Promise<void> {
    if (!window.confirm(`Delete "${lib.name}"? This does not delete files on disk.`)) return;
    try {
      await apiDelete("/libraries/{id}", { params: { path: { id: lib.id } } });
      setLibraries((prev) => (prev ? prev.filter((l) => l.id !== lib.id) : prev));
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to delete library.");
    }
  }

  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}

      <div className={styles.header}>
        <h2 className={styles.title}>
          Libraries{libraries !== null && <span className={styles.countMono}> · {libraries.length}</span>}
        </h2>
      </div>

      {error && <p className={styles.errorBanner}>{error}</p>}

      {libraries === null ? (
        <div className={styles.skeletonList} aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} radius="md" height={72} />
          ))}
        </div>
      ) : libraries.length === 0 ? (
        <EmptyState icon={HardDrive} title="No libraries yet" body="Create one to start scanning media into your catalog." />
      ) : (
        <div className={styles.list}>
          {libraries.map((lib) => (
            <LibraryRow
              key={lib.id}
              library={lib}
              scanStatus={scanStatuses.get(lib.id)}
              onScan={(full) => void handleScan(lib, full)}
              onEdit={() => setEditing(lib)}
              onPermissions={() => setManagingPermissions(lib)}
              onProviderChain={() => setManagingProviderChain(lib)}
              onDelete={() => void handleDelete(lib)}
            />
          ))}
        </div>
      )}

      <button type="button" className={styles.addTile} onClick={() => setAdding(true)}>
        + Add library
      </button>

      <AddLibrarySheet open={adding} onClose={() => setAdding(false)} onCreated={(lib) => setLibraries((prev) => (prev ? [lib, ...prev] : [lib]))} />

      {editing && (
        <EditLibraryModal
          library={editing}
          onClose={() => setEditing(null)}
          onUpdated={(lib) => setLibraries((prev) => (prev ? prev.map((l) => (l.id === lib.id ? lib : l)) : prev))}
        />
      )}
      {managingPermissions && <PermissionsModal library={managingPermissions} onClose={() => setManagingPermissions(null)} />}
      {managingProviderChain && <ProviderChainModal library={managingProviderChain} onClose={() => setManagingProviderChain(null)} />}
    </div>
  );
}
