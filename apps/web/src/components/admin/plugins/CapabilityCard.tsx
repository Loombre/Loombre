// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/plugins/CapabilityCard.tsx
//
// LPP v1, Lane W5: renders ONE manifest-declared capability for the C4
// confirmation screen and the plugin detail page's manifest summary — the
// household-register privacy line (lib/plugin-manifest.ts#describeCapabilityScope)
// plus type-specific facts (media kinds / requested event types). No
// per-plugin branching here, only per-capability-TYPE (C8: additive —
// a future capability type needs a new case here, never a rewrite of this
// component's shape).

import { Chip } from "../../ui/Chip.js";
import { Toggle } from "../../ui/Toggle.js";
import { capabilityTypeLabel, describeCapabilityScope, type PluginCapability } from "../../../lib/plugin-manifest.js";
import styles from "./CapabilityCard.module.css";

const MEDIA_KIND_LABELS: Record<string, string> = { movie: "Movies", tv: "TV shows", music: "Music" };

export interface CapabilityCardProps {
  capability: PluginCapability;
  /** When provided, the card renders a "Grant this capability" toggle
   *  (C4's confirmation screen — the admin picks which manifest-declared
   *  capability TYPES to actually enable). Absent = purely informational
   *  (the detail page's manifest summary). */
  selection?: { checked: boolean; onChange: (checked: boolean) => void };
}

export function CapabilityCard({ capability, selection }: CapabilityCardProps): React.JSX.Element {
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.title}>{capabilityTypeLabel(capability.type)}</span>
        <span className={styles.contentClassPill} data-restricted={capability.contentClass === "restricted"}>
          {capability.contentClass === "restricted" ? "Restricted libraries only" : "General"}
        </span>
        {selection && (
          <Toggle
            checked={selection.checked}
            onChange={selection.onChange}
            label={selection.checked ? "Granted" : "Not granted"}
            className={styles.selectionToggle}
          />
        )}
      </div>

      <p className={styles.scopeLine}>{describeCapabilityScope(capability)}</p>

      {capability.type === "metadata-provider" && (
        <div className={styles.facts}>
          {capability.mediaKinds.map((kind) => (
            <Chip key={kind}>{MEDIA_KIND_LABELS[kind] ?? kind}</Chip>
          ))}
        </div>
      )}

      {capability.type === "event-subscriber" && (
        <div className={styles.facts}>
          {capability.eventTypes.map((eventType) => (
            <Chip key={eventType}>{eventType}</Chip>
          ))}
        </div>
      )}
    </div>
  );
}
