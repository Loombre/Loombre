// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/libraries/StashPathMappingsPanel.tsx
//
// StashModal's "Path mappings" tab: GET/PUT /admin/libraries/{id}/
// stash-path-mappings (wholesale replace) + the LIVE PREVIEW via
// POST .../stash-path-mappings/preview against the CANDIDATE (unsaved)
// rows in state (STATE.md S4/K10, FX1 item 2).
//
// Row array logic (add/remove/reorder) is the pure lib/stash-path-
// mappings.ts, same split ProviderChainEditor.tsx keeps with
// lib/library-provider-chain.ts — this component holds only `rows` in
// React state and calls the pure functions for every mutation. Reorder
// uses the same up/down-button convention (no drag library), since
// AdminStashPathMappings' own schema comment is explicit that matching is
// longest-prefix-wins independent of display order (K10) — reordering here
// is for the admin's own bookkeeping, not the matcher.
//
// Preview debounce mirrors app/restricted/search/page.tsx's established
// two-stage shape exactly: a ref-held debounce() delays committing the
// edited rows into `debouncedWire` (trailing-edge, so a fast typist never
// fires one request per keystroke); a separate effect keyed on
// `debouncedWire` does the actual POST with a `cancelled` closure flag
// guarding a late response from a superseded edit. Only COMPLETE rows
// (both prefixes filled) are sent — an in-progress new row is silently
// excluded rather than firing a request that would 422 before its second
// field is typed (completeMappingsOnly's own doc comment).

import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { Icon } from "../../icon/Icon.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { debounce } from "../../../lib/debounce.js";
import {
  addMappingRow,
  completeMappingsOnly,
  draftFromMappings,
  mappingsAreDirty,
  mappingsAreValid,
  moveMappingRowDown,
  moveMappingRowUp,
  removeMappingRowAt,
  toWireMappings,
  updateMappingRowField,
  type MappingDraftRow,
  type MappingWireInput,
} from "../../../lib/stash-path-mappings.js";
import { apiGet, apiPost, apiPut } from "../../../lib/api-client.js";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./StashPathMappingsPanel.module.css";

type AdminStashConnection = components["schemas"]["AdminStashConnection"];
type AdminStashPathMappingPreview = components["schemas"]["AdminStashPathMappingPreview"];

const PREVIEW_DEBOUNCE_MS = 400;

export function StashPathMappingsPanel({
  libraryId,
  connection,
}: {
  libraryId: string;
  connection: AdminStashConnection;
}): React.JSX.Element {
  const [rows, setRows] = useState<MappingDraftRow[] | null>(null);
  const [original, setOriginal] = useState<MappingDraftRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [debouncedWire, setDebouncedWire] = useState<MappingWireInput[]>([]);
  const [preview, setPreview] = useState<AdminStashPathMappingPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/admin/libraries/{id}/stash-path-mappings", { params: { path: { id: libraryId } } })
      .then((res) => {
        const draft = draftFromMappings(res.mappings);
        setOriginal(draft);
        setRows(draft);
      })
      .catch((err) => setLoadError(apiErrorCopy(err, "Failed to load path mappings.")));
  }, [libraryId]);

  const debouncedSetWire = useRef(debounce((wire: MappingWireInput[]) => setDebouncedWire(wire), PREVIEW_DEBOUNCE_MS)).current;
  useEffect(() => () => debouncedSetWire.cancel(), [debouncedSetWire]);

  useEffect(() => {
    if (rows === null) return;
    debouncedSetWire(completeMappingsOnly(rows));
  }, [rows, debouncedSetWire]);

  useEffect(() => {
    if (debouncedWire.length === 0) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    apiPost("/admin/libraries/{id}/stash-path-mappings/preview", {
      params: { path: { id: libraryId } },
      body: { mappings: debouncedWire },
    })
      .then((res) => {
        if (cancelled) return;
        setPreview(res);
        setPreviewLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setPreviewError(apiErrorCopy(err, "Failed to preview these mappings."));
        setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedWire, libraryId]);

  async function handleSave(): Promise<void> {
    if (rows === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiPut("/admin/libraries/{id}/stash-path-mappings", {
        params: { path: { id: libraryId } },
        body: { mappings: toWireMappings(rows) },
      });
      const draft = draftFromMappings(res.mappings);
      setOriginal(draft);
      setRows(draft);
    } catch (err) {
      setSaveError(apiErrorCopy(err, "Failed to save these path mappings."));
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <p className={styles.errorText}>{loadError}</p>;

  if (rows === null) {
    return (
      <div className={styles.skeletonList} aria-hidden="true">
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} radius="md" height={44} />
        ))}
      </div>
    );
  }

  const valid = mappingsAreValid(rows);
  const dirty = mappingsAreDirty(original, rows);
  const completeCount = completeMappingsOnly(rows).length;

  return (
    <div className={styles.wrap}>
      {!connection.configured && (
        <p className={styles.note}>
          This library has no Stash connection configured yet (Connection tab) — mappings can still be edited and
          previewed, but the preview will show zero total scenes until at least one inventory pass has run.
        </p>
      )}

      <ol className={styles.list}>
        {rows.map((row, index) => (
          <li key={row.key} className={styles.row}>
            <span className={styles.position}>{index + 1}</span>
            <TextInput
              className={styles.prefixInput}
              value={row.stashPrefix}
              onChange={(e) => setRows(updateMappingRowField(rows, index, "stashPrefix", e.target.value))}
              placeholder="/data/scenes"
              aria-label={`Mapping ${index + 1} — Stash prefix`}
            />
            <Icon icon={ArrowRight} size="dense" aria-hidden />
            <TextInput
              className={styles.prefixInput}
              value={row.loombrePrefix}
              onChange={(e) => setRows(updateMappingRowField(rows, index, "loombrePrefix", e.target.value))}
              placeholder="/media/movies"
              aria-label={`Mapping ${index + 1} — Loombre prefix`}
            />
            <div className={styles.rowActions}>
              <Button variant="ghost" iconOnly onClick={() => setRows(moveMappingRowUp(rows, index))} disabled={index === 0} title="Move up">
                <Icon icon={ChevronUp} size="dense" aria-label={`Move mapping ${index + 1} up`} />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                onClick={() => setRows(moveMappingRowDown(rows, index))}
                disabled={index === rows.length - 1}
                title="Move down"
              >
                <Icon icon={ChevronDown} size="dense" aria-label={`Move mapping ${index + 1} down`} />
              </Button>
              <Button variant="ghost" iconOnly onClick={() => setRows(removeMappingRowAt(rows, index))} title="Remove">
                <Icon icon={X} size="dense" aria-label={`Remove mapping ${index + 1}`} />
              </Button>
            </div>
          </li>
        ))}
        {rows.length === 0 && <li className={styles.empty}>No path mappings yet.</li>}
      </ol>

      <p className={styles.hint}>
        Matching uses the longest matching Stash prefix, independent of this order — reorder rows for your own
        reference only.
      </p>

      <Button variant="secondary" onClick={() => setRows(addMappingRow(rows))}>
        <Icon icon={Plus} size="dense" aria-hidden /> Add mapping
      </Button>

      <div className={styles.previewCard}>
        <p className={styles.previewLabel}>Live preview</p>
        <p className={styles.hint}>Reflects the library&apos;s last Stash inventory pass, not a live scan of your Stash database.</p>
        {completeCount === 0 ? (
          <p className={styles.hint}>Add at least one complete mapping to preview matches.</p>
        ) : previewError ? (
          <p className={styles.errorText}>{previewError}</p>
        ) : previewLoading && !preview ? (
          <Skeleton radius="sm" height={20} width="60%" />
        ) : (
          preview && (
            <>
              <p className={styles.countLine} data-loading={previewLoading || undefined}>
                {preview.candidateMatchCount} of {preview.totalStashScenes} files matched
              </p>
              {preview.unmatchedCount > 0 && (
                <div className={styles.unmatchedWrap}>
                  <p className={styles.hint}>
                    {preview.unmatchedCount} unmatched{preview.unmatchedScenes.length < preview.unmatchedCount ? ` (showing ${preview.unmatchedScenes.length})` : ""}
                  </p>
                  <ul className={styles.unmatchedList}>
                    {preview.unmatchedScenes.map((scene) => (
                      <li key={scene.stashSceneId} className={styles.unmatchedRow}>
                        <span className={styles.unmatchedPath}>{scene.stashPath}</span>
                        {scene.rewrittenPath && <span className={styles.unmatchedRewrite}>→ {scene.rewrittenPath}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )
        )}
      </div>

      {saveError && <p className={styles.errorText}>{saveError}</p>}

      <div className={styles.actions}>
        <Button variant="primary" onClick={() => void handleSave()} disabled={saving || !valid || !dirty}>
          {saving ? "Saving…" : "Save mappings"}
        </Button>
      </div>
    </div>
  );
}
