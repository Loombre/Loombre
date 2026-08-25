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
// Restricted libraries (browser-admin-F7): this pane lists exactly what
// GET /libraries returns for the signed-in admin — a restricted library
// they hold no grant on, or hold one but have not unlocked, is ABSENT
// here, and that is the server's answer, not a bug to paper over
// client-side. AddLibrarySheet's post-create step is where an admin
// grants themselves access to one they just made.
//
// d3-d5 (browser-admin-F7 follow-up): "the server withheld it" was still a
// dead end for libraries created BEFORE that grant step existed (or
// imported/seeded) — nothing listed them, the permissions editor is fed by
// this same viewer-scoped list, so no grant could ever be issued and they
// were unreachable forever. The pane now also reads the ADMINISTRATION-
// scoped listing (GET /libraries?scope=admin, admin-only) and renders the
// DIFFERENCE between the two scopes as a separate "Not visible to you"
// group with the grant attached. The main list above it is untouched: it
// is still exactly the viewer-scoped answer, never a merge of the two.
//
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
import { StashModal } from "../../admin/libraries/StashModal.js";
import { RowMenu } from "../RowMenu.js";
import { AddLibrarySheet } from "./AddLibrarySheet.js";
import { useLibraryScanStatus } from "./use-library-scan-status.js";
import { libraryPathLabel } from "./library-path-label.js";
import { subscribeCatalogInvalidation } from "../../../lib/catalog-invalidation.js";
import { diffPermissionsToSubmit } from "../../../lib/library-permissions.js";
import { enumLabel, MEDIA_KIND_LABEL } from "../../../lib/enum-labels.js";
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
  onStash,
  onDelete,
}: {
  library: Library;
  scanStatus: { scanning: boolean; lastCompletedAtMs: number | null } | undefined;
  onScan: (full: boolean) => void;
  onEdit: () => void;
  onPermissions: () => void;
  onProviderChain: () => void;
  onStash: () => void;
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
        <Tag>{enumLabel(MEDIA_KIND_LABEL, library.mediaKind)}</Tag>
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
            // STATE.md FIX WAVE FX1: Stash only ever applies to a
            // restricted library (K7's contentClass 'restricted' — the
            // only content class the built-in `stash` provider registers
            // against) — offered here exactly like the "restricted" chip
            // two lines up, off the SAME library.contentClass check, never
            // a separate lookup.
            ...(library.contentClass === "restricted" ? [{ label: "Stash", onSelect: onStash }] : []),
            { label: "Edit", onSelect: onEdit },
            { label: "Delete", onSelect: onDelete, danger: true },
          ]}
        />
      </div>
    </div>
  );
}

/** d3-d5: the "Not visible to you" group — the libraries the
 *  administration-scoped listing knows about that the viewer-scoped one
 *  withholds. Deliberately NOT a LibraryRow: none of that row's actions
 *  (scan, provider chain, stash, edit, delete) belong on a library this
 *  admin cannot see the contents of, and its live scan badge would be
 *  meaningless here. The one action offered is the one that ENDS this
 *  state. */
function HiddenLibraryRow({
  library,
  onGrant,
  granting,
}: {
  library: Library;
  onGrant: () => void;
  granting: boolean;
}): React.JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>{library.name}</span>
          <span className={styles.rowSub}>{libraryPathLabel(library.paths) ?? "—"}</span>
        </div>
      </div>
      <div className={styles.rowChips}>
        <Tag>{enumLabel(MEDIA_KIND_LABEL, library.mediaKind)}</Tag>
        {library.contentClass === "restricted" && <Tag>restricted</Tag>}
      </div>
      <div className={styles.rowEnd}>
        <Button type="button" variant="ghost" onClick={onGrant} disabled={granting}>
          {granting ? "Granting…" : "Grant yourself access"}
        </Button>
      </div>
    </div>
  );
}

export function LibrariesSection({ heading }: { heading: string | null }): React.JSX.Element {
  const { showToast } = useToast();
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  // d3-d5: null = the administration-scoped listing is unavailable to this
  // caller (403 — not an admin) or failed. That is NOT an error banner:
  // this pane's primary list is fine, and a viewer who cannot ask the
  // administration question should simply not be told there is one.
  const [hidden, setHidden] = useState<Library[] | null>(null);
  const [granting, setGranting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Library | null>(null);
  const [managingPermissions, setManagingPermissions] = useState<Library | null>(null);
  const [managingProviderChain, setManagingProviderChain] = useState<Library | null>(null);
  const [managingStash, setManagingStash] = useState<Library | null>(null);
  const scanStatuses = useLibraryScanStatus();

  function reload(): void {
    // The two scopes are read INDEPENDENTLY (never chained): the primary
    // list must not wait on — or be lost to — the administration one, which
    // a non-admin is legitimately refused.
    apiGet("/libraries", { params: { query: { limit: 200 } } })
      .then((page) => setLibraries(page.items))
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load libraries."));
    apiGet("/libraries", { params: { query: { scope: "admin", limit: 200 } } })
      .then((page) => setHidden(page.items))
      .catch(() => setHidden(null));
  }

  useEffect(reload, []);

  // d3-d7: RestrictedProvider.unlock()/lock() fire emitCatalogInvalidation()
  // on every confirmed transition, and BOTH of this pane's answers move
  // with gate 5 — an unlock adds every granted restricted library to the
  // viewer-scoped list and removes it from the "Not visible to you" group,
  // a lock does the reverse. Loading once (useEffect(reload, [])) left the
  // pane reading "Libraries · 4" for as long as the admin stayed on it
  // after unlocking, while the F7 panel's own copy told them unlocking is
  // what makes the library appear HERE. Same seam every other catalog
  // consumer is meant to use; `reload` only calls stable state setters, so
  // capturing the first one is deliberate, not a stale closure.
  useEffect(() => subscribeCatalogInvalidation(reload), []);

  /** d3-d5: the diff is computed at RENDER time off the two server
   *  answers, never stored — the same "derived data is never a second
   *  piece of state" rule this file's header states for the header count.
   *  Both must have arrived for the diff to mean anything: while the
   *  viewer-scoped list is still loading, EVERY library would look hidden. */
  const hiddenFromViewer =
    hidden === null || libraries === null
      ? []
      : hidden.filter((lib) => !libraries.some((visible) => visible.id === lib.id));

  /** The grant §6.4 gate 4 wants, issued through the same existence-scoped
   *  admin route AddLibrarySheet's post-create step uses — it reaches a
   *  library this admin cannot yet see, and PUT replaces grants only for
   *  the userIds it names, so nobody else's access is disturbed. */
  async function handleGrantSelf(lib: Library): Promise<void> {
    setGranting(lib.id);
    try {
      const me = await apiGet("/users/me");
      await apiPut("/libraries/{id}/permissions", {
        params: { path: { id: lib.id } },
        body: { libraryId: lib.id, permissions: [{ userId: me.id, granted: true }] },
      });
      // Honest about what a grant does and does not do: gate 4 is now
      // satisfied, but a RESTRICTED library still needs this device's live
      // unlock (gate 5) before it joins the list above.
      showToast(
        lib.contentClass === "restricted"
          ? `ACCESS GRANTED — ${lib.name.toUpperCase()} · UNLOCK RESTRICTED CONTENT TO SEE IT`
          : `ACCESS GRANTED — ${lib.name.toUpperCase()}`,
      );
      reload();
    } catch (err) {
      showToast(err instanceof LoombreApiError ? err.message : "Failed to grant access.", { variant: "danger" });
    } finally {
      setGranting(null);
    }
  }

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
      {/* LD-5 (owner QA, 2026-08-10): the in-content "Libraries · N" heading
          duplicated this page title — removed; the count now attaches
          directly to the page title instead of living in its own
          redundant h2. */}
      {heading !== null && (
        <h1 className={styles.heading}>
          {heading}
          {libraries !== null && <span className={styles.countMono}> · {libraries.length}</span>}
        </h1>
      )}

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
              onStash={() => setManagingStash(lib)}
              onDelete={() => void handleDelete(lib)}
            />
          ))}
        </div>
      )}

      <button type="button" className={styles.addTile} onClick={() => setAdding(true)}>
        + Add library
      </button>

      {hiddenFromViewer.length > 0 && (
        <section className={styles.subSection}>
          <h2 className={styles.title}>
            Not visible to you
            <span className={styles.countMono}> · {hiddenFromViewer.length}</span>
          </h2>
          <p className={styles.note}>
            These libraries exist on this server but are not in your own list — either you hold no access grant on
            them, or they are restricted and this device is locked (the lock in the header). Granting yourself
            access is gate 4 of docs/PLAN.md §6.4; a restricted library also needs that unlock before it appears
            above.
          </p>
          <div className={styles.list}>
            {hiddenFromViewer.map((lib) => (
              <HiddenLibraryRow
                key={lib.id}
                library={lib}
                granting={granting === lib.id}
                onGrant={() => void handleGrantSelf(lib)}
              />
            ))}
          </div>
        </section>
      )}

      {/* browser-admin-F7 (QA 2026-08-21): onCreated used to splice the
          POST /libraries response straight into this state. For a
          restricted library that row is a LIE — GET /libraries is
          viewer-scoped and the creating admin gets no auto-grant by design
          (packages/db/src/query/libraries.ts, §6.4 gate 4), so the row
          appeared for one render and the next reload silently deleted it.
          The callback is now a "go look again" signal: this list only ever
          shows what the server says it shows, and AddLibrarySheet owns
          explaining what a restricted creation still needs. */}
      <AddLibrarySheet open={adding} onClose={() => setAdding(false)} onCreated={reload} />

      {editing && (
        <EditLibraryModal
          library={editing}
          onClose={() => setEditing(null)}
          onUpdated={(lib) => setLibraries((prev) => (prev ? prev.map((l) => (l.id === lib.id ? lib : l)) : prev))}
        />
      )}
      {managingPermissions && <PermissionsModal library={managingPermissions} onClose={() => setManagingPermissions(null)} />}
      {managingProviderChain && <ProviderChainModal library={managingProviderChain} onClose={() => setManagingProviderChain(null)} />}
      {managingStash && <StashModal library={managingStash} onClose={() => setManagingStash(null)} />}
    </div>
  );
}
