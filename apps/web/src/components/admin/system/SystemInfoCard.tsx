// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/system/SystemInfoCard.tsx
//
// D-5 (Wave 2, this run — IA restructure): extracted verbatim (Version/OS/
// Tier/Node/Uptime facts, GET /system/info) from the deleted
// app/admin/system/page.tsx's SystemInfoCard, now composed on the merged
// Dashboard (app/admin/page.tsx) instead — same endpoint, same fields, same
// behavior, only the file location and its render site changed. See
// app/admin/page.tsx's own header for why Dashboard's existing mono status
// line (version + uptime only) doesn't make this card redundant: this is
// the FULL fact set (OS/tier/node too), not a duplicate of that compact
// readout.

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { Card } from "../../ui/Card.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { formatOsLabel } from "../../../lib/os-label.js";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import styles from "./system-cards.module.css";

type SystemInfo = components["schemas"]["SystemInfo"];

export function SystemInfoCard(): React.JSX.Element {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/system/info")
      .then(setInfo)
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load system info."));
  }, []);

  return (
    <Card>
      {/* "Server info", not "System": this card sits directly under the
          merged Dashboard's own "System" section heading (app/admin/
          page.tsx) — keeping the old System-page card title produced a
          stacked "System / System" (W3-R visual sweep). */}
      <h2 className={styles.cardTitle}>Server info</h2>
      {error && <p className={styles.errorText}>{error}</p>}
      {!info ? (
        <Skeleton radius="md" height={80} />
      ) : (
        <dl className={styles.factGrid}>
          <dt>Version</dt>
          <dd>{info.version}</dd>
          <dt>OS</dt>
          {/* AUD-A4v4-005: proper-noun label map, not text-transform:
              capitalize — that rendered "Macos". */}
          <dd>{formatOsLabel(info.os)}</dd>
          <dt>Tier</dt>
          <dd>T{info.tier}</dd>
          <dt>Node</dt>
          <dd>{info.nodeVersion ?? "—"}</dd>
          <dt>Uptime</dt>
          <dd>{info.uptimeMs != null ? `${Math.floor(info.uptimeMs / 60_000)} min` : "—"}</dd>
        </dl>
      )}
    </Card>
  );
}
