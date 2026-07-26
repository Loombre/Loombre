// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/LibrariesPanel.tsx
//
// Admin dashboard LIBRARIES section (Phosphor retheme Wave 2, Lane L2 —
// design/phosphor/README.md "Admin dashboard": "LIBRARIES (name, kind,
// item count, state, last scan, SCAN NOW / PAUSE, and an n UNMATCHED ·
// REVIEW disclosure that expands scan errors with a FIX MATCH action)").
// Reflows app/admin/libraries/page.tsx's existing scan-enqueue wiring
// (unchanged: POST /libraries/{id}/scan) rather than rebuilding it, and
// adds three genuinely new pieces this wave: live per-library scan state
// (lib/admin-dashboard-live.ts, the events socket — no polling), the
// derived "n UNMATCHED" disclosure (GET /admin/libraries/{id}/unmatched,
// additive this lane), and the FIX MATCH flow (components/admin/
// FixMatch.tsx, the reusable item-scoped component this lane owns for the
// whole Phosphor run).
//
// GAPS logged, never fabricated (U9):
//   - PAUSE: no backing endpoint anywhere in the contract/job queue —
//     omitted entirely, not rendered as an inert/broken button.
//   - "state" (idle/scanning) and "last scan" timestamp: the jobs ledger
//     has no library_id column at all (POST /libraries/{id}/scan enqueues
//     with subjectItemId: null — libraries.controller.ts), so a scan job
//     cannot be correlated back to "which library" from the ledger alone.
//     The one signal that IS real and live is "is this library scanning
//     RIGHT NOW" (scan.started/scan.completed events, correlated by
//     jobId->libraryId) — rendered as a live "SCANNING" indicator with an
//     indeterminate bar; a static last-scan-completed-at timestamp is
//     omitted (would need either a new library column or a new admin
//     query over the events outbox — out of this lane's additive scope).

import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Button } from "../ui/Button.js";
import { Tag } from "../ui/Chip.js";
import { EmptyState } from "./EmptyState.js";
import { FixMatch } from "./FixMatch.js";
import { Skeleton } from "../skeleton/Skeleton.js";
import { getLibraryScanState, useLibraryScanState } from "../../lib/admin-dashboard-live.js";
import { apiGet, apiPost, LoombreApiError } from "../../lib/api-client.js";
import styles from "./LibrariesPanel.module.css";

type Library = components["schemas"]["Library"];
type UnmatchedItem = components["schemas"]["UnmatchedLibraryItem"];

const UNMATCHED_PAGE_LIMIT = 100;

interface UnmatchedState {
  items: UnmatchedItem[];
  /** True when GET .../unmatched's nextCursor was non-null at
   *  UNMATCHED_PAGE_LIMIT — the count shown is a floor, not fabricated
   *  precision past what one page actually proved (U9). */
  truncated: boolean;
}

function LibraryDashboardRow({
  library,
  scanState,
}: {
  library: Library;
  scanState: ReturnType<typeof getLibraryScanState>;
}): React.JSX.Element {
  const [unmatched, setUnmatched] = useState<UnmatchedState | null>(null);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [fixingItem, setFixingItem] = useState<{ id: string; title: string } | null>(null);

  function refetchUnmatched(): void {
    apiGet("/admin/libraries/{id}/unmatched", { params: { path: { id: library.id }, query: { limit: UNMATCHED_PAGE_LIMIT } } })
      .then((page) => setUnmatched({ items: page.items, truncated: page.nextCursor !== null }))
      .catch(() => setUnmatched({ items: [], truncated: false }));
  }

  useEffect(refetchUnmatched, [library.id]);

  async function handleScan(): Promise<void> {
    setScanStatus("enqueuing…");
    try {
      await apiPost("/libraries/{id}/scan", { params: { path: { id: library.id } }, body: { full: false } });
      setScanStatus("scan enqueued");
    } catch (err) {
      setScanStatus(err instanceof LoombreApiError ? err.message : "failed to enqueue");
    }
  }

  const unmatchedCount = unmatched?.items.length ?? 0;

  return (
    <div className={styles.row}>
      <div className={styles.mainLine}>
        <span className={styles.name}>{library.name}</span>
        <Tag>{library.mediaKind}</Tag>
        <span className={styles.count}>{library.itemCount} items</span>
        {scanState.scanning && (
          <span className={styles.scanningBadge}>
            <span className={styles.scanBar} aria-hidden="true" />
            Scanning{scanState.filesProcessed !== null ? ` · ${scanState.filesProcessed} files` : ""}
          </span>
        )}
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => void handleScan()} disabled={scanState.scanning}>
          {scanState.scanning ? "Scanning…" : "Scan now"}
        </Button>
        {scanStatus && <span className={styles.scanStatus}>{scanStatus}</span>}
      </div>

      {unmatchedCount > 0 && (
        <details className={styles.unmatchedDisclosure}>
          <summary className={styles.unmatchedSummary}>
            {unmatchedCount}
            {unmatched?.truncated ? "+" : ""} unmatched · review
          </summary>
          <ul className={styles.unmatchedList}>
            {unmatched!.items.map((item) => (
              <li key={item.itemId} className={styles.unmatchedItem}>
                <div className={styles.unmatchedMain}>
                  <span className={styles.unmatchedTitle}>
                    {item.title}
                    {item.year !== null ? ` (${item.year})` : ""}
                  </span>
                  {item.filePath && <span className={styles.unmatchedPath}>{item.filePath}</span>}
                </div>
                <Button variant="secondary" onClick={() => setFixingItem({ id: item.itemId, title: item.title })}>
                  Fix match
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {fixingItem && (
        <FixMatch
          itemId={fixingItem.id}
          itemTitle={fixingItem.title}
          open
          onClose={() => setFixingItem(null)}
          onApplied={refetchUnmatched}
        />
      )}
    </div>
  );
}

export function LibrariesPanel(): React.JSX.Element {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scanStateMap = useLibraryScanState(true);

  useEffect(() => {
    apiGet("/libraries", { params: { query: { limit: 200 } } })
      .then((page) => setLibraries(page.items))
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load libraries."));
  }, []);

  return (
    <div>
      <div className={styles.header}>
        <h2 className={styles.title}>Libraries</h2>
      </div>
      {error && <p className={styles.empty}>{error}</p>}
      {libraries === null ? (
        <div className={styles.list} aria-hidden="true">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} radius="md" height={72} />
          ))}
        </div>
      ) : libraries.length === 0 ? (
        <EmptyState icon={HardDrive} title="No libraries yet" body="Create one from Settings to start scanning media into your catalog." />
      ) : (
        <div className={styles.list}>
          {libraries.map((library) => (
            <LibraryDashboardRow key={library.id} library={library} scanState={getLibraryScanState(scanStateMap, library.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
