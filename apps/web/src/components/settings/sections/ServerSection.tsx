// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/ServerSection.tsx
//
// README tab 1 "Server": name/address (RENAME), hardware transcoding
// status, and the telemetry row. Ground-truthed against the real contract
// (this lane's freeze report has the full table):
//
//   - Server RENAME: NO endpoint exists anywhere (SystemInfo has no `name`
//     field; there is no PATCH /system or /admin/system route in
//     packages/contract/openapi.yaml). OMITTED per this lane's hard line
//     (U9 — never fabricate a row with no backing data); logged here and
//     in the freeze report rather than shipping a fake text field.
//   - Hardware transcoding status: REAL — GET /system/capabilities's
//     `details["hw-transcode"]` (apps/server/src/session/system.controller.ts),
//     honestly reported `{enabled:false, description:"...Not yet
//     implemented (Phase 3)."}` today. Rendered as-is; this section does
//     NOT claim hardware transcoding works.
//   - Telemetry row: copy is VERBATIM per this lane's brief, and is a
//     static assertion of CLAUDE.md invariant 7 (no telemetry/analytics/
//     phone-home of any kind, ever) — not a data value from any endpoint,
//     so there is nothing to fabricate here.

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { Card } from "../../ui/Card.js";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import styles from "./ServerSection.module.css";

type Capabilities = components["schemas"]["Capabilities"];

function HardwareTranscodeCard(): React.JSX.Element {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/system/capabilities")
      .then(setCaps)
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load capabilities."));
  }, []);

  const detail = caps?.details["hw-transcode"];

  return (
    <Card>
      <h2 className={styles.cardTitle}>Hardware transcoding</h2>
      {error && <p className={styles.errorText}>{error}</p>}
      {!caps ? (
        <Skeleton radius="md" height={48} />
      ) : (
        <div className={styles.statusRow}>
          <span className={styles.statusPill} data-enabled={detail?.enabled ?? false}>
            {detail?.enabled ? "Enabled" : "Not available"}
          </span>
          <p className={styles.statusDetail}>{detail?.description ?? "No status reported by this server."}</p>
        </div>
      )}
    </Card>
  );
}

export function ServerSection({ heading }: { heading: string | null }): React.JSX.Element {
  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}

      <HardwareTranscodeCard />

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
