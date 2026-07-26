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
// P4.6 DEVIATION (see this lane's report): manual path entry ONLY. The
// task spec's literal wording says "library paths (native folder picker
// via platform controller apps; manual path entry always available)" —
// but the controller-IPC contract (packages/controller-ipc) has no picker
// operation in v1 (grep confirms: no "pickFolder"/"selectDirectory"-shaped
// op anywhere in that package or openapi.yaml's admin surface). Rendering
// a fake picker button would be dishonest UX; this step is manual-entry-
// only with an explicit helper note saying so, which the task text itself
// anticipates ("manual path entry ALWAYS; ... render the input with
// helper text honestly").
//
// This step is skippable: a user who plans to restore from a backup
// afterward (the RestoreStep, which requires an empty instance — see
// ../wizard-state.ts's module header) should skip manual library creation
// entirely.

import { useState, type FormEvent } from "react";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { LoombreApiError } from "@loombre/sdk";
import { Icon } from "../../../components/icon/Icon.js";
import { Button } from "../../../components/ui/Button.js";
import { TextInput } from "../../../components/ui/Input.js";
import { SegmentedControl } from "../../../components/ui/SegmentedControl.js";
import { apiPost } from "../../../lib/api-client.js";
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

  function updatePath(index: number, value: string): void {
    setPaths((prev) => prev.map((p, i) => (i === index ? value : p)));
  }
  function addPath(): void {
    setPaths((prev) => [...prev, ""]);
  }
  function removePath(index: number): void {
    setPaths((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
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
      setSubmitError(err instanceof LoombreApiError ? err.message : "Could not reach the server.");
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
        <span className={styles.label}>Folder path(s)</span>
        <span className={styles.hint}>
          Type the path on the server&apos;s filesystem — there is no folder-browse button yet
          (the desktop-controller app doesn&apos;t expose one in this release).
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
    </form>
  );
}
