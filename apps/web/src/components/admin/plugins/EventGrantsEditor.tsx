// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/plugins/EventGrantsEditor.tsx
//
// LPP v1, Lane W5: "event-grant selection (requested types shown, admin
// checks the GRANTED subset)". A plain checkbox-per-event-type list — the
// manifest's requestedEventTypes (lib/plugin-manifest.ts) is the fixed
// universe; nothing here can ever check a box outside that set, so the
// server-side "granted <= requested" invariant is unbreakable from this UI
// by construction, not just by validation.

"use client";

import { Toggle } from "../../ui/Toggle.js";
import styles from "./EventGrantsEditor.module.css";

export interface EventGrantsEditorProps {
  requestedEventTypes: readonly string[];
  grantedEventTypes: readonly string[];
  onChange: (next: string[]) => void;
}

export function EventGrantsEditor({ requestedEventTypes, grantedEventTypes, onChange }: EventGrantsEditorProps): React.JSX.Element {
  const granted = new Set(grantedEventTypes);

  function toggle(eventType: string, checked: boolean): void {
    const next = new Set(granted);
    if (checked) next.add(eventType);
    else next.delete(eventType);
    onChange([...next]);
  }

  return (
    <div className={styles.list}>
      <p className={styles.helpText}>
        This plugin asks to receive the activity feed events below. Choose which ones it actually gets — anything
        left unchecked is never sent to it, and you can change your mind at any time from this plugin&apos;s page.
      </p>
      {requestedEventTypes.length === 0 && (
        <p className={styles.empty}>This plugin doesn&apos;t request any activity feed events.</p>
      )}
      {requestedEventTypes.map((eventType) => (
        <label key={eventType} className={styles.row}>
          <Toggle checked={granted.has(eventType)} onChange={(checked) => toggle(eventType, checked)} />
          <span className={styles.eventType}>{eventType}</span>
        </label>
      ))}
    </div>
  );
}
