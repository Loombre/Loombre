// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/libraries/StashConnectionPanel.tsx
//
// StashModal's "Connection" tab: GET/PUT /admin/libraries/{id}/
// stash-connection (STATE.md S2/S3/K15, FX1 item 1). Two things this panel
// owns honestly:
//
//   - The observed connection status (worker-written, never editable
//     here): status pill + verbatim statusDetail (S3's exact admin notice,
//     "Stash schema vNN unsupported; supported: X-Y", finally surfaced to
//     a human) + lastSeenSchemaVersion/lastConnectedAtMs/lastCheckedAtMs,
//     all rendered as "—" rather than a fabricated value when null (the
//     library has never had a connect attempt yet).
//
//   - genreTagNames' TRI-STATE contract (K15): omit=untouched /
//     null=reset-to-heuristic / array=replace. This form deliberately
//     never relies on the "omit" branch — every Save explicitly declares
//     intent (`null` for "Default (automatic)", a — possibly empty —
//     array for "Custom list"), so what the admin sees in the toggle is
//     exactly what gets written, with no silent "nothing changed" case to
//     reason about. The toggle only starts on "Custom list" when the
//     saved value is already a non-null array; a fresh connection (or one
//     explicitly reset) starts on "Default".

import { useState } from "react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { Toggle } from "../../ui/Toggle.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { StatusPill } from "../StatusPill.js";
import { describeStashConnectionStatus } from "../../../lib/admin-status.js";
import { apiPut } from "../../../lib/api-client.js";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./StashConnectionPanel.module.css";

type AdminStashConnection = components["schemas"]["AdminStashConnection"];

function formatTime(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

const GENRE_MODES = ["Default (automatic)", "Custom list"] as const;
type GenreMode = (typeof GENRE_MODES)[number];

export function StashConnectionPanel({
  connection,
  onSaved,
}: {
  connection: AdminStashConnection;
  onSaved: (connection: AdminStashConnection) => void;
}): React.JSX.Element {
  const [sqlitePath, setSqlitePath] = useState(connection.sqlitePath ?? "");
  const [blobsPath, setBlobsPath] = useState(connection.blobsPath ?? "");
  const [enabled, setEnabled] = useState(connection.enabled);
  const [genreMode, setGenreMode] = useState<GenreMode>(connection.genreTagNames === null ? "Default (automatic)" : "Custom list");
  const [genreNamesText, setGenreNamesText] = useState((connection.genreTagNames ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const statusInfo = describeStashConnectionStatus(connection.status);
  const canSubmit = sqlitePath.trim().length > 0;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const genreTagNames =
      genreMode === "Default (automatic)"
        ? null
        : genreNamesText
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    try {
      // Empty field ⇒ null (clear, DB-only art); a path ⇒ set it. Always
      // sent, so what's on screen is what's written (matches genreTagNames).
      const trimmedBlobs = blobsPath.trim();
      const saved = await apiPut("/admin/libraries/{id}/stash-connection", {
        params: { path: { id: connection.libraryId } },
        body: { sqlitePath: sqlitePath.trim(), enabled, genreTagNames, blobsPath: trimmedBlobs.length > 0 ? trimmedBlobs : null },
      });
      onSaved(saved);
    } catch (err) {
      setError(apiErrorCopy(err, "Failed to save the Stash connection."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.wrap}>
      {!connection.configured && (
        <p className={styles.note}>
          This library has no Stash connection yet. Fill in the SQLite path below and save to configure one — Loombre
          will connect read-only and never writes to your Stash database.
        </p>
      )}

      <div className={styles.statusCard}>
        <div className={styles.statusRow}>
          <StatusPill label={statusInfo.label} tone={statusInfo.tone} />
          {connection.enabled === false && connection.configured && <span className={styles.disabledNote}>disabled</span>}
        </div>
        {connection.statusDetail && <p className={styles.statusDetail}>{connection.statusDetail}</p>}
        <dl className={styles.statusMeta}>
          <div>
            <dt>Schema version</dt>
            <dd>{connection.lastSeenSchemaVersion ?? "—"}</dd>
          </div>
          <div>
            <dt>Last connected</dt>
            <dd>{formatTime(connection.lastConnectedAtMs)}</dd>
          </div>
          <div>
            <dt>Last checked</dt>
            <dd>{formatTime(connection.lastCheckedAtMs)}</dd>
          </div>
        </dl>
      </div>

      <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
        <label className={styles.field}>
          <span className={styles.label}>Stash SQLite path</span>
          <TextInput
            value={sqlitePath}
            onChange={(e) => setSqlitePath(e.target.value)}
            placeholder="/path/to/stash-go.sqlite"
            required
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Stash blobs path (optional)</span>
          <TextInput
            value={blobsPath}
            onChange={(e) => setBlobsPath(e.target.value)}
            placeholder="/path/to/stash/blobs"
          />
          <p className={styles.hint}>
            Only needed if your Stash stores cover art on its filesystem rather than in the database. Point this at
            Stash&apos;s blobs directory to sync cover, performer, and studio images. Leave blank to read art only from
            the database.
          </p>
        </label>

        <div className={styles.formRow}>
          <span className={styles.label}>Enabled</span>
          <Toggle checked={enabled} onChange={setEnabled} label={enabled ? "Enabled" : "Disabled"} />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>Genre tags</span>
          <SegmentedControl options={[...GENRE_MODES]} defaultValue={genreMode} onChange={(v) => setGenreMode(v as GenreMode)} />
          {genreMode === "Default (automatic)" ? (
            <p className={styles.hint}>
              A Stash tag with no parent maps to a genre; a child tag stays a plain tag. This is Loombre&apos;s
              built-in heuristic.
            </p>
          ) : (
            <>
              <p className={styles.hint}>
                One Stash tag name per line. These names map to genre wholesale, case-insensitively, overriding the
                heuristic above. An empty list is valid — it means no tag maps to genre.
              </p>
              <textarea
                className={styles.textarea}
                value={genreNamesText}
                onChange={(e) => setGenreNamesText(e.target.value)}
                rows={3}
                placeholder={"Thriller\nWestern"}
                aria-label="Genre tag names"
              />
            </>
          )}
        </div>

        {error && <p className={styles.errorText}>{error}</p>}

        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={saving || !canSubmit}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}
