// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/ServerSection.tsx
//
// README tab 1 "Server": name/address (RENAME), Power, hardware
// capabilities (rendered as CapabilitiesCard's own "Verified hardware
// capabilities" card, not a "Hardware transcoding" label — see that
// bullet below), and the telemetry row. Ground-truthed against the real
// contract (this lane's freeze report has the full table):
//
//   - Server RENAME: NO endpoint exists anywhere (SystemInfo has no `name`
//     field; there is no PATCH /system or /admin/system route in
//     packages/contract/openapi.yaml). OMITTED per this lane's hard line
//     (U9 — never fabricate a row with no backing data); logged here and
//     in the freeze report rather than shipping a fake text field.
//   - Hardware transcoding status: LD-2 fix (owner QA, 2026-08-10) — this
//     card used to call GET /system/capabilities and read
//     `details["hw-transcode"]`. That route is PUBLIC/unauthenticated and
//     deliberately zero-I/O (apps/server/src/session/system.controller.ts)
//     — it hardcodes `hw-transcode.enabled: false` UNCONDITIONALLY, by
//     design, specifically so an anonymous caller can never learn this
//     machine's real hardware; its own description even says so ("Whether
//     this machine has usable backends is reported on the admin
//     Dashboard, which requires an admin session."). So this card was
//     structurally incapable of ever showing "Enabled" — wrong endpoint,
//     not a stale cache or a probe bug. Every /settings/* route is
//     adminOnly (section-registry.ts), so this surface can safely call the
//     real admin-gated GET /admin/capabilities instead — and rather than
//     re-deriving the W1 three-state probe/report logic a second time,
//     this now composes the EXACT SAME CapabilitiesCard component the
//     admin Dashboard renders (components/admin/system/CapabilitiesCard.tsx,
//     which itself uses the shared hasNoAcceleratedCapabilities derivation
//     — lib/capability-view.ts), so the two surfaces can never disagree
//     again.
//   - Telemetry row: copy is VERBATIM per this lane's brief, and is a
//     static assertion of CLAUDE.md invariant 7 (no telemetry/analytics/
//     phone-home of any kind, ever) — not a data value from any endpoint,
//     so there is nothing to fabricate here.
//
// LD-3 (owner QA, 2026-08-10): section order is Power / Verified hardware
// capabilities (CapabilitiesCard's own heading — this section composes
// that card verbatim, it does not render a "Hardware transcoding" label of
// its own) / Telemetry — reorder only, no content changes.

import { Card } from "../../ui/Card.js";
import { CapabilitiesCard } from "../../admin/system/CapabilitiesCard.js";
import { ServerPowerCard } from "./ServerPowerCard.js";
import styles from "./ServerSection.module.css";

export function ServerSection({ heading }: { heading: string | null }): React.JSX.Element {
  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}

      {/* Power (restart/shutdown — POST /system/restart|shutdown landed
          with this card; the U9 no-fake-controls line above no longer
          applies to these two, they have real backing endpoints). */}
      <ServerPowerCard />

      <CapabilitiesCard />

      <Card>
        <h2 className={styles.cardTitle}>Telemetry</h2>
        <p className={styles.telemetryLine}>NONE. THERE IS NO PHONE-HOME CODE TO TURN OFF. — BY DESIGN</p>
      </Card>

      <p className={styles.omittedNote}>
        Server rename is not implemented yet — there is no rename endpoint on this build, so no control is shown here
        rather than a fake one.
      </p>
    </div>
  );
}
