// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/setup/_components/LibraryStep.tsx
//
// POST /libraries + a follow-up POST /libraries/{id}/scan (task spec:
// "Library creation uses the existing POST /libraries + auto-scan
// trigger" — createLibrary itself does NOT enqueue a scan job server-side,
// apps/server/src/catalog/libraries.controller.ts's createLibrary handler
// has no enqueue() call, so the wizard triggers it explicitly as a second
// call, full:true for a first import).
//
// FOLDER BROWSING (P4.6 deviation, reversed): the original deviation
// declared this step manual-entry-only because the spec's imagined picker
// was a NATIVE one via the controller apps, and the controller-IPC
// contract has no picker op. That rationale went stale when the
// server-enumeration picker landed (GET /admin/filesystem/directories +
// components/settings/sections/DirectoryPicker.tsx, the same dialog
// Settings > Library uses). Auth is no obstacle: the wizard's step order
// puts this AFTER admin creation, and AdminStep applies the first-admin
// TokenPair to the auth store, so this step is a live admin and reaches
// the admin-only browse endpoint through the ordinary api-client
// plumbing. Manual entry stays fully supported alongside — headless
// installs and container-only mounts still need typing (DirectoryPicker's
// own header: Browse is an affordance, not a gate).
//
// This step is skippable: a user who plans to restore from a backup
// afterward (the RestoreStep, which requires an empty instance — see
// ../wizard-state.ts's module header) should skip manual library creation
// entirely.

import { useState, type FormEvent } from "react";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { Icon } from "../../../components/icon/Icon.js";
import { DirectoryPicker } from "../../../components/settings/sections/DirectoryPicker.js";
import { Button } from "../../../components/ui/Button.js";
import { TextInput } from "../../../components/ui/Input.js";
import { SegmentedControl } from "../../../components/ui/SegmentedControl.js";
import { apiPost } from "../../../lib/api-client.js";
import { apiErrorMessage } from "../../../lib/api-error-message.js";
import { validateLibraryForm, type LibraryFormErrors } from "../wizard-state.js";
import styles from "./steps.module.css";

export interface LibraryStepProps {
  onNext: (createdLibrary: boolean) => void;
}

const MEDIA_KIND_LABELS: Record<string, "movie" | "tv" | "music"> = {
  Movies: "movie",
  "TV Shows": "tv",
  Music: "music",
};

export function LibraryStep({ onNext }: LibraryStepProps): React.JSX.Element {
  const [name, setName] = useState("");
  const [mediaKind, setMediaKind] = useState<"movie" | "tv" | "music">("movie");
  const [paths, setPaths] = useState<string[]>([""]);
  const [errors, setErrors] = useState<LibraryFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  function updatePath(index: number, value: string): void {
    setPaths((prev) => prev.map((p, i) => (i === index ? value : p)));
  }
  function addPath(): void {
    setPaths((prev) => [...prev, ""]);
  }
  function removePath(index: number): void {
    setPaths((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }
  /** A browsed pick fills the first empty field, else appends a new row —
   *  de-duplicated, same rule as AddLibrarySheet (a library with the same
   *  path twice would have the scanner walk it twice for nothing). */
  function handlePicked(picked: string): void {
    setPaths((prev) => {
      const trimmed = prev.map((p) => p.trim());
      if (trimmed.includes(picked)) return prev;
      const emptyIndex = trimmed.findIndex((p) => p.length === 0);
      if (emptyIndex >= 0) return prev.map((p, i) => (i === emptyIndex ? picked : p));
      return [...prev, picked];
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitError(null);

    const trimmedPaths = paths.map((p) => p.trim()).filter((p) => p.length > 0);
    const fieldErrors = validateLibraryForm({ name, paths: trimmedPaths });
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    setSubmitting(true);
    try {
      const library = await apiPost("/libraries", {
        body: { name, mediaKind, paths: trimmedPaths },
      });
      // Best-effort: a scan-trigger failure shouldn't block onboarding —
      // the library exists either way and can be rescanned from Admin.
      try {
        await apiPost("/libraries/{id}/scan", {
          params: { path: { id: library.id } },
          body: { full: true },
        });
      } catch {
        // Non-fatal — see comment above.
      }
      onNext(true);
    } catch (err) {
      // Detail-first (V-UX F2/F3): the RFC 9457 `detail` is the server's
      // actionable sentence; bare err.message is only the status title.
      setSubmitError(apiErrorMessage(err, "Could not reach the server."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.step} onSubmit={handleSubmit} noValidate>
      <div className={styles.iconBadge} aria-hidden="true">
        <Icon icon={FolderOpen} />
      </div>
      <h2 className={styles.subtitle}>Add a library</h2>
      <p className={styles.body}>
        Point Loombre at a folder of media. You can add more libraries later from Admin →
        Libraries — feel free to skip this and come back, especially if you plan to restore
        from a backup on the next step instead.
      </p>

      <label className={styles.field} htmlFor="setup-library-name">
        <span className={styles.label}>Library name</span>
        <TextInput id="setup-library-name" required value={name} onChange={(e) => setName(e.target.value)} />
        {errors.name && <span className={styles.fieldError}>{errors.name}</span>}
      </label>

      <div className={styles.field}>
        <span className={styles.label}>Type</span>
        <SegmentedControl
          options={Object.keys(MEDIA_KIND_LABELS)}
          defaultValue="Movies"
          onChange={(v) => setMediaKind(MEDIA_KIND_LABELS[v] ?? "movie")}
        />
      </div>

      <div className={styles.field}>
        {/* The Browse button lives OUTSIDE any label on purpose — a button
            nested inside a label steals the label's click (the same trap
            AddLibrarySheet documents on its pathsHeader). */}
        <div className={styles.pathsHeader}>
          <span className={styles.label}>Folder path(s)</span>
          <Button type="button" variant="ghost" onClick={() => setPickerOpen(true)}>
            Browse…
          </Button>
        </div>
        <span className={styles.hint}>
          Folders on the machine running Loombre — browse them, or type a path directly
          (a headless install or a container-only mount still needs typing).
        </span>
        <div className={styles.pathList}>
          {paths.map((p, i) => (
            <div className={styles.pathRow} key={i}>
              <TextInput
                aria-label={`Library path ${i + 1}`}
                placeholder="/mnt/media/movies"
                value={p}
                onChange={(e) => updatePath(i, e.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                iconOnly
                className={styles.removePathButton}
                aria-label="Remove this path"
                disabled={paths.length <= 1}
                onClick={() => removePath(i)}
              >
                <Icon icon={Trash2} size="dense" aria-label="Remove this path" />
              </Button>
            </div>
          ))}
        </div>
        {errors.paths && <span className={styles.fieldError}>{errors.paths}</span>}
        <Button type="button" variant="ghost" className={styles.addPathButton} onClick={addPath}>
          <Icon icon={Plus} size="dense" aria-hidden /> Add another path
        </Button>
      </div>

      {submitError && <div className={styles.error}>{submitError}</div>}

      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={() => onNext(false)}>
          Skip for now
        </Button>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? "Creating…" : "Create library & start scan"}
        </Button>
      </div>

      <DirectoryPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={handlePicked} />
    </form>
  );
}
