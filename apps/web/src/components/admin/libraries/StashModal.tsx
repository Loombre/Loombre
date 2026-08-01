// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/libraries/StashModal.tsx
//
// STATE.md FIX WAVE FX1: the admin Stash settings UI — "the surface no
// lane was assigned; the API is fully landed and tested" (Lanes A-E). This
// is the "Stash" RowMenu action's target for a RESTRICTED library, opened
// from components/settings/sections/LibrariesSection.tsx exactly the way
// ProviderChainModal.tsx (../libraries/ProviderChainEditor.js) is opened
// from the same row menu — one Modal per library, GET-on-open, explicit
// Save. This modal itself is chrome only: a SegmentedControl tab strip
// (Connection / Path Mappings / Sync) over three independent panels, each
// owning its own fetch/save cycle exactly like ProviderChainModal owns its
// chain — the same "GET/PUT around one resource, one Modal" shape,
// repeated three times inside one wider dialog instead of three separate
// row-menu entries, because the four API surfaces (connection,
// path-mappings + preview, sync, sync-report) are one admin *feature*,
// not four independent library settings.
//
// The connection GET is lifted to THIS component (not owned by
// StashConnectionPanel) because StashPathMappingsPanel and StashSyncPanel
// both need `connection` too, for their own honest empty states ("no
// connection configured yet" / "this connection is disabled" — mission
// item 5): the path-mapping preview and a manual sync both nominally work
// against whatever's already been inventoried even before this session
// edits anything, but a disabled connection makes every worker-side
// connect attempt fail outright (apps/worker/src/stash/connect.ts's own
// `!connRow.enabled` short-circuit, read for this lane's ground truth,
// never touched) — so the Sync tab can disable its buttons and say why
// instead of letting an admin fire a doomed sync.

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { Modal } from "../Modal.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { StashConnectionPanel } from "./StashConnectionPanel.js";
import { StashPathMappingsPanel } from "./StashPathMappingsPanel.js";
import { StashSyncPanel } from "./StashSyncPanel.js";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import styles from "./StashModal.module.css";

type Library = components["schemas"]["Library"];
type AdminStashConnection = components["schemas"]["AdminStashConnection"];

const TABS = ["Connection", "Path mappings", "Sync"] as const;
type Tab = (typeof TABS)[number];

export function StashModal({ library, onClose }: { library: Library; onClose: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("Connection");
  const [connection, setConnection] = useState<AdminStashConnection | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reload(): void {
    apiGet("/admin/libraries/{id}/stash-connection", { params: { path: { id: library.id } } })
      .then(setConnection)
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load the Stash connection."));
  }

  useEffect(reload, [library.id]);

  return (
    <Modal title={`Stash — ${library.name}`} onClose={onClose}>
      <div className={styles.wrap}>
        <SegmentedControl options={[...TABS]} defaultValue="Connection" onChange={(v) => setTab(v as Tab)} />

        {error && <p className={styles.errorText}>{error}</p>}

        {!connection ? (
          <div className={styles.skeletonList} aria-hidden="true">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} radius="md" height={40} />
            ))}
          </div>
        ) : (
          <>
            {tab === "Connection" && <StashConnectionPanel connection={connection} onSaved={setConnection} />}
            {tab === "Path mappings" && <StashPathMappingsPanel libraryId={library.id} connection={connection} />}
            {tab === "Sync" && <StashSyncPanel libraryId={library.id} connection={connection} />}
          </>
        )}
      </div>
    </Modal>
  );
}
