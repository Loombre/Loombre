// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/DirectoryPicker.tsx
//
// The "Browse" half of the Add-library dialog's path field.
//
// WHY THIS IS NOT AN <input type="file" webkitdirectory>. A library path
// names a directory on the SERVER's filesystem. The browser can only see
// the machine it is running on, and that is frequently not the server —
// the Docker distribution puts the web UI in a different container
// entirely, and a LAN user administering the server from a laptop is the
// normal case, not an edge case. An OS file dialog would return a path
// that is either meaningless to the server or, worse, coincidentally
// valid and pointing somewhere wrong. So the SERVER enumerates
// (GET /admin/filesystem/directories, admin-only, directory names only)
// and this component walks that listing.
//
// The free-text field it sits beside stays fully functional and is NOT
// replaced: a headless install, a path that only exists inside a
// container, or a mount this host cannot reach all still need typing.
// Browse is an affordance, not a gate.

import { useCallback, useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import { Button } from "../../ui/Button.js";
import { SheetOrModal } from "../../ui/SheetOrModal.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import styles from "./DirectoryPicker.module.css";

type DirectoryListing = components["schemas"]["DirectoryListing"];

export interface DirectoryPickerProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen absolute path. The caller decides what to do
   *  with it (AddLibrarySheet appends it as a new line). */
  onSelect: (path: string) => void;
}

export function DirectoryPicker({ open, onClose, onSelect }: DirectoryPickerProps): React.JSX.Element {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((path: string | null) => {
    setLoading(true);
    setError(null);
    // Typed query params, not a hand-built URL: apiGet is generic over the
    // SDK's literal path union, so a template string is not even
    // assignable — which is the generated client doing its job. It also
    // handles the encoding, so a path with spaces or a '#' cannot escape.
    // Omitting `path` entirely = the roots listing.
    apiGet("/admin/filesystem/directories", path === null ? undefined : { params: { query: { path } } })
      .then((next) => {
        setListing(next as DirectoryListing);
        setLoading(false);
      })
      .catch((err: unknown) => {
        // The server distinguishes these cases deliberately (422 not
        // absolute, 403 unreadable, 404 missing) and its messages say what
        // to do about each, so surface them rather than a generic failure.
        setError(err instanceof LoombreApiError ? err.message : "Could not read that directory.");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    // Always reopen at the roots rather than wherever the last session
    // ended: a stale deep path that has since been unmounted would open
    // the picker straight into an error.
    load(null);
  }, [open, load]);

  const atRoots = listing?.path === null;

  return (
    <SheetOrModal
      open={open}
      onClose={onClose}
      title="Choose a folder"
      sub="Folders on the machine running Loombre — not on this computer, if they are different."
    >
      <div className={styles.picker}>
        <div className={styles.crumbRow}>
          <code className={styles.currentPath}>{listing?.path ?? "This server"}</code>
          <Button
            type="button"
            variant="ghost"
            onClick={() => load(listing?.parent ?? null)}
            // At a root there is nowhere up to go — the server reports
            // parent:null precisely so this can be disabled rather than
            // navigating to itself.
            disabled={loading || atRoots}
          >
            Up
          </Button>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        {loading ? (
          <div className={styles.list}>
            <Skeleton radius="md" height={32} />
            <Skeleton radius="md" height={32} />
            <Skeleton radius="md" height={32} />
          </div>
        ) : (
          <ul className={styles.list}>
            {listing?.entries.length === 0 && (
              <li className={styles.empty}>No sub-folders here. You can still choose this folder.</li>
            )}
            {listing?.entries.map((entry) => (
              <li key={entry.path}>
                <button type="button" className={styles.entry} onClick={() => load(entry.path)}>
                  <span className={styles.entryName}>{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            // Choosing the CURRENT folder, not a highlighted child: a media
            // library is the folder you have navigated into. Disabled at
            // the roots listing, where `path` is null and there is nothing
            // concrete to choose.
            disabled={loading || listing?.path == null}
            onClick={() => {
              if (listing?.path == null) return;
              onSelect(listing.path);
              onClose();
            }}
          >
            Use this folder
          </Button>
        </div>
      </div>
    </SheetOrModal>
  );
}
