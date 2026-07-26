// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/EventLogPanel.tsx
//
// The admin dashboard's collapsible event log (design/phosphor/README.md
// "Admin dashboard": "a collapsible... event log"). Client-side only — a
// bounded ring buffer (lib/admin-dashboard-live.ts's useEventLog) over the
// SAME shared events websocket every authenticated session already holds
// open, no new endpoint or persisted log surface ("existing... events
// surfaces reflowed, not rebuilt"). Admin-only outbox types (job.updated,
// settings.updated, plugin.*, metadata.match-candidates) only ever reach
// an admin socket in the first place (ws-broadcaster.service.ts's
// ADMIN_ONLY_TYPES), so this panel — admin-only by construction, it only
// ever renders inside /admin — never needs its own extra filtering.

import { useEventLog } from "../../lib/admin-dashboard-live.js";
import styles from "./EventLogPanel.module.css";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/** Cheap per-kind colouring (MED, W3 fidelity audit — "only if kind data
 *  exists"): the "kind" IS real data here, not invented — every one of the
 *  24 closed envelope.schema.json event types is genuinely
 *  `<kind>.<verb>` (job.updated, restricted.locked, plugin.enabled, …), so
 *  splitting on the first "." is reading a real field, not guessing a
 *  taxonomy. `restricted.*` gets the warning tone this app already uses
 *  everywhere else for that concept; everything else stays the existing
 *  neutral text color — no semantics invented beyond what the type string
 *  itself already states. */
function eventKindTone(type: string): "warning" | undefined {
  return type.startsWith("restricted.") ? "warning" : undefined;
}

export function EventLogPanel({ isAdmin }: { isAdmin: boolean }): React.JSX.Element {
  const entries = useEventLog(isAdmin);

  if (entries.length === 0) {
    return <p className={styles.empty}>Nothing yet — live activity will appear here as it happens.</p>;
  }

  return (
    <ul className={styles.list} role="list" aria-label="Event log">
      {entries.map((entry) => (
        <li key={entry.id} className={styles.row}>
          <span className={styles.type} data-tone={eventKindTone(entry.type)}>
            {entry.type}
          </span>
          <span className={styles.time}>{formatTime(entry.tsMs)}</span>
        </li>
      ))}
    </ul>
  );
}
