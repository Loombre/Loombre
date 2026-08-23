// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/MetadataCard.tsx
//
// Movie-detail METADATA card (design/phosphor/README.md "Movie detail":
// "EDIT / FIX MATCH actions and six rows: Match confidence, Director,
// Studio, Audio, Subtitles, Added"). Ground-truthed per the Wave-2 L4
// brief before writing a single row:
//
//   - Match confidence: NO field anywhere — grepped packages/contract/
//     openapi.yaml and packages/db/migrations/**/*.sql for "confidence"
//     (case-insensitive), zero hits. No metadata-provider match score is
//     stored or returned by anything today. OMITTED, not fabricated.
//   - Studio: same result — grepped for "studio", zero hits in the
//     contract or any migration. OMITTED.
//   - Director: real — PersonCredit.role === 'director' on the item's
//     people[] (packages/contract's PersonRole enum).
//   - Audio / Subtitles: real — MediaFileSummary.audioTracks/
//     subtitleTracks (this lane's additive contract extension, see
//     VersionCard.tsx's header), read off the item's DEFAULT file.
//   - Added: real — CatalogItemBase.addedAtMs.
//
// EDIT ground-truth (same brief): packages/contract/openapi.yaml has no
// PATCH/PUT for movies/series/episodes — only updateUser, updateMe,
// updateLibrary, updateAdminSetting/PluginConfig/PluginEventGrants exist.
// No admin item-metadata-update endpoint exists server-side, and item
// editing semantics interact with metadata_lock (docs/PLAN.md §8.3: "stored
// provenance per field, not per item") and provider refresh — a design
// decision for an owner, not a fan-out lane to invent via a new contract
// op (this lane's HARD LINES: "anything design-shaped -> stop and
// report"). So EDIT renders disabled-with-tooltip, per the brief's own
// explicit fallback instruction, rather than a dead-end sheet with nowhere
// to submit.
//
// FIX MATCH: L2's real component, swapped in at Wave-2 landing per the
// stub's documented contract (the former FixMatchStub is deleted). The
// card owns the open/close state; FixMatch renders SheetOrModal itself.
//
// FIX MATCH is ADMIN-ONLY (QA 2026-08-21 browser-casual-F1, P2): both
// endpoints behind it are /admin/* and requireAdmin-guarded server-side
// (apps/server/src/catalog/admin.controller.ts), so for a non-admin the
// button used to open a sheet that immediately dead-ended on the 403's
// bare "Forbidden". The card now takes `isAdmin` and renders neither the
// button nor the FixMatch mount without it — the affordance simply is not
// there, matching the sidebar's SYSTEM group and the command palette. The
// caller resolves the flag (lib/use-is-admin.ts); this component stays
// presentational, like every other card in this directory. The gate is UX
// only — the server-side check remains the real boundary.
//
// EDIT is deliberately left as-is (rendered, permanently disabled, with
// the tooltip above): it is a dead affordance for EVERYONE, admin
// included, because no item-update endpoint exists at all — so it is not
// an admin-visibility leak and hiding it for non-admins alone would
// misrepresent why it is unavailable.

import { useState } from "react";
import type { components } from "@loombre/sdk";
import { FixMatch } from "../admin/FixMatch.js";
import { formatAudioMetaRow, formatDirectorLabel, formatRelativeAdded, formatSubtitlesMetaRow } from "./format.js";
import styles from "./MetadataCard.module.css";

type PersonCredit = components["schemas"]["PersonCredit"];
type MediaFileSummary = components["schemas"]["MediaFileSummary"];

export interface MetadataCardProps {
  itemId: string;
  itemTitle: string;
  /** Whether the VIEWER is an admin. Gates FIX MATCH (an /admin/* flow) —
   *  pass `false` while the answer is still unknown, never `true`
   *  optimistically, so no admin-only chrome flashes. UX only; the server
   *  is still the boundary. */
  isAdmin: boolean;
  people: PersonCredit[] | undefined;
  defaultFile: MediaFileSummary | undefined;
  addedAtMs: number;
}

export function MetadataCard({ itemId, itemTitle, isAdmin, people, defaultFile, addedAtMs }: MetadataCardProps): React.JSX.Element {
  const [fixMatchOpen, setFixMatchOpen] = useState(false);
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.eyebrow}>METADATA</span>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.actionPill}
            disabled
            title="Editing item metadata isn't available yet — no server-side item-update endpoint exists (metadata_lock/provider-refresh semantics need an owner decision first)"
          >
            EDIT
          </button>
          {isAdmin && (
            <>
              <button type="button" className={styles.actionPill} onClick={() => setFixMatchOpen(true)}>
                FIX MATCH
              </button>
              <FixMatch
                itemId={itemId}
                itemTitle={itemTitle}
                open={fixMatchOpen}
                onClose={() => setFixMatchOpen(false)}
                onApplied={() => setFixMatchOpen(false)}
              />
            </>
          )}
        </div>
      </div>
      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>Director</dt>
          <dd className={styles.value}>{formatDirectorLabel(people)}</dd>
        </div>
        <div className={styles.row}>
          <dt>Audio</dt>
          <dd className={styles.monoValue}>{formatAudioMetaRow(defaultFile?.audioTracks)}</dd>
        </div>
        <div className={styles.row}>
          <dt>Subtitles</dt>
          <dd className={styles.monoValue}>{formatSubtitlesMetaRow(defaultFile?.subtitleTracks)}</dd>
        </div>
        <div className={styles.row}>
          <dt>Added</dt>
          <dd className={styles.monoValue}>{formatRelativeAdded(addedAtMs)}</dd>
        </div>
      </dl>
    </div>
  );
}
