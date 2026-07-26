// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/AddLibrarySheet.tsx
//
// README "+ ADD LIBRARY" flow: "path, detected file count, read-only
// reassurance, kind chips, Create & scan." Built on the shared
// SheetOrModal primitive (sheet ≤767.98px / dialog above — W1b/W1a
// reconciled breakpoint), replacing the pre-IA CreateLibraryModal
// (components/admin/Modal.tsx-based) that lived in
// apps/web/src/app/admin/libraries/page.tsx.
//
// Ground-truthed deviations from the prototype's literal 4 fields (this
// lane's freeze report has the full table):
//   - "Detected file count" — NO endpoint exists (no preview/probe route
//     before creation anywhere in the contract) — OMITTED per U9, logged
//     here rather than shown as a fake number.
//   - "Name" is REQUIRED by the real CreateLibraryRequest (packages/
//     contract/openapi.yaml) but isn't one of the prototype's literal
//     fields — added, since a library cannot be created without one.
//   - "Path" (singular) becomes a multi-line paths textarea — the real
//     endpoint accepts an array of paths, and dropping that to a single
//     path would be a real capability regression versus what
//     CreateLibraryModal already shipped.
//   - "Create & scan": real behavior, not just a button label — POST
//     /libraries followed immediately by POST /libraries/{id}/scan
//     (full: false), chaining two existing endpoints. A create failure
//     never attempts the scan call.

import { useState } from "react";
import { SheetOrModal } from "../../ui/SheetOrModal.js";
import { TextInput } from "../../ui/Input.js";
import { Button } from "../../ui/Button.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { useToast } from "../../ui/Toast.js";
import { apiPost, LoombreApiError } from "../../../lib/api-client.js";
import type { components } from "@loombre/sdk";
import styles from "./shared.module.css";

type Library = components["schemas"]["Library"];
type MediaKind = components["schemas"]["MediaKind"];

const MEDIA_KINDS: MediaKind[] = ["movie", "tv", "music"];

export function AddLibrarySheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (lib: Library) => void;
}): React.JSX.Element {
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [mediaKind, setMediaKind] = useState<MediaKind>("movie");
  const [restricted, setRestricted] = useState(false);
  const [pathsText, setPathsText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const paths = pathsText
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  const canSubmit = name.trim().length > 0 && paths.length > 0;

  function reset(): void {
    setName("");
    setMediaKind("movie");
    setRestricted(false);
    setPathsText("");
    setError(null);
    setSubmitting(false);
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const lib = await apiPost("/libraries", {
        body: { name, mediaKind, paths, contentClass: restricted ? "restricted" : "general" },
      });
      // "Create & scan" — real chained behavior, not fabricated: a scan
      // enqueue failure here doesn't undo the library create (same
      // best-effort posture the standalone Scan button always had), it
      // just doesn't get a "scan started" toast.
      try {
        await apiPost("/libraries/{id}/scan", { params: { path: { id: lib.id } }, body: { full: false } });
        showToast(`LIBRARY CREATED · SCAN STARTED — ${lib.name.toUpperCase()}`);
      } catch {
        showToast(`LIBRARY CREATED — ${lib.name.toUpperCase()}`);
      }
      onCreated(lib);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to create library.");
      setSubmitting(false);
    }
  }

  return (
    <SheetOrModal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Add library"
      sub="Loombre only reads these paths — scanning never renames, moves, or modifies your source files."
    >
      <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Kind</span>
          <SegmentedControl options={MEDIA_KINDS} defaultValue="movie" onChange={(v) => setMediaKind(v as MediaKind)} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Paths (one per line)</span>
          <textarea
            className={styles.textarea}
            value={pathsText}
            onChange={(e) => setPathsText(e.target.value)}
            placeholder="/data/movies"
            rows={3}
            required
          />
        </label>
        <div className={styles.formRow}>
          <span className={styles.label}>Restricted content</span>
          <SegmentedControl options={["General", "Restricted"]} defaultValue="General" onChange={(v) => setRestricted(v === "Restricted")} />
        </div>
        {restricted && (
          <p className={styles.note}>
            Restricted just marks the library — visibility still requires the server capability to be enabled,
            explicit per-user grants, and each user&apos;s own age/opt-in/PIN and live unlock. Requires
            LOOMBRE_RESTRICTED_ENABLED on this instance.
          </p>
        )}
        {error && <p className={styles.errorText}>{error}</p>}
        <div className={styles.actions}>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit || submitting}>
            {submitting ? "Creating…" : "Create & scan"}
          </Button>
        </div>
      </form>
    </SheetOrModal>
  );
}
