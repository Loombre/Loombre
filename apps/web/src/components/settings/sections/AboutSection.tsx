// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/AboutSection.tsx
//
// README tab 8 "About": version, runtime, build/migration, and the
// "GROUND-UP. NOT A FORK. NO TELEMETRY." tagline. Real data only —
// GET /system/info (admin-only; SystemInfo: version/os/tier/nodeVersion/
// uptimeMs). There is no "build/migration hash" field anywhere in the
// contract (ground-truthed against SystemInfo and SystemUpdateInfo, see
// this lane's freeze report) — omitted rather than fabricated (U9).
// GET /system/update (channel/latestVersion/updateAvailable) is
// deliberately NOT duplicated here: the Dashboard's own UpdateNoticeCard
// (D-5, Wave 2 — components/admin/system/UpdateNoticeCard.tsx, composed on
// app/admin/page.tsx; formerly apps/admin/system/page.tsx's inline card of
// the same name, merged in this run) already covers it in full
// (verification banner etc.) — showing a second, thinner copy of the same
// data on this tab would drift out of sync with that one over time for no
// benefit.

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { Card } from "../../ui/Card.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import { formatOsLabel } from "../../../lib/os-label.js";
import styles from "./AboutSection.module.css";

type SystemInfo = components["schemas"]["SystemInfo"];

export function AboutSection({ heading }: { heading: string | null }): React.JSX.Element {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/system/info")
      .then(setInfo)
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load system info."));
  }, []);

  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}

      <Card>
        {error && <p className={styles.errorText}>{error}</p>}
        {!info ? (
          <Skeleton radius="md" height={96} />
        ) : (
          <dl className={styles.factGrid}>
            <dt>Version</dt>
            <dd>{info.version}</dd>
            <dt>OS</dt>
            {/* AUD-A4v4-005: proper-noun label map, not text-transform:
                capitalize — that rendered "Macos". */}
            <dd>{formatOsLabel(info.os)}</dd>
            <dt>Runtime (Node)</dt>
            <dd>{info.nodeVersion ?? "—"}</dd>
            <dt>Uptime</dt>
            <dd>{info.uptimeMs != null ? `${Math.floor(info.uptimeMs / 60_000)} min` : "—"}</dd>
          </dl>
        )}
      </Card>

      <p className={styles.tagline}>GROUND-UP. NOT A FORK. NO TELEMETRY.</p>
    </div>
  );
}
