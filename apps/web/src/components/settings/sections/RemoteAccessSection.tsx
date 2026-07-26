// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/RemoteAccessSection.tsx
//
// README tab 5 "Remote Access": "detected reverse proxy, TLS/HSTS/
// TRUST_PROXY, and TOKEN REDACTION IN PROXY LOGS: VERIFIED." Ground-truthed
// (this lane's freeze report): there is no "detected reverse proxy" probe
// and no token-redaction-verification endpoint anywhere in the contract —
// both OMITTED per U9 rather than fabricated. What IS real:
//   - GET /system/capabilities's `details["remote-access"]` — honestly
//     `{enabled:false, description:"Built-in ACME/remote exposure. Not yet
//     implemented."}` today (same capability-flag surface ServerSection
//     uses for hw-transcode).
//   - The registry's `network`/`tls` categories (network.trustProxy,
//     network.corsOrigins, tls.mode) — all env-only, so every one of these
//     renders SettingField's locked/read-only display (a Lock icon + "set
//     by environment" caption), never a fake editable control. Same
//     un-restyled reuse as PlaybackSection.

import Link from "next/link";
import type { components } from "@loombre/sdk";
import { Card } from "../../ui/Card.js";
import { SettingsCategoryCard } from "../../admin/settings/SettingsCategoryCard.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { apiGet } from "../../../lib/api-client.js";
import { useAdminSettingsData } from "./use-admin-settings-data.js";
import { useEffect, useState } from "react";
import styles from "./RemoteAccessSection.module.css";

type Capabilities = components["schemas"]["Capabilities"];

export function RemoteAccessSection({ heading }: { heading: string | null }): React.JSX.Element {
  const { schema, settings, error, refetch } = useAdminSettingsData();
  const [caps, setCaps] = useState<Capabilities | null>(null);

  useEffect(() => {
    apiGet("/system/capabilities")
      .then(setCaps)
      .catch(() => setCaps(null));
  }, []);

  const remoteAccess = caps?.details["remote-access"];
  const networkEntries = schema?.entries.filter((entry) => entry.category === "network") ?? [];
  const tlsEntries = schema?.entries.filter((entry) => entry.category === "tls") ?? [];
  const valuesByKey = new Map((settings?.settings ?? []).map((s) => [s.key, s] as const));

  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}

      <Card>
        <h2 className={styles.cardTitle}>Built-in remote access</h2>
        <div className={styles.statusRow}>
          <span className={styles.statusPill} data-enabled={remoteAccess?.enabled ?? false}>
            {remoteAccess?.enabled ? "Enabled" : "Not available"}
          </span>
          <p className={styles.statusDetail}>
            {remoteAccess?.description ?? "No status reported by this server."}
          </p>
        </div>
      </Card>

      <p className={styles.helpText}>
        No "detected reverse proxy" probe or proxy-log token-redaction verification exists on this build — omitted
        rather than shown as a fake confirmation. What IS configurable today is the trust-proxy / CORS / TLS
        environment configuration below (all environment-pinned, never editable from this surface).
      </p>
      {error && <p className={styles.errorText}>{error}</p>}
      {!schema || !settings ? (
        <Skeleton radius="lg" height={160} />
      ) : networkEntries.length > 0 || tlsEntries.length > 0 ? (
        <>
          {networkEntries.length > 0 && (
            <SettingsCategoryCard category="network" entries={networkEntries} valuesByKey={valuesByKey} onChanged={refetch} />
          )}
          {tlsEntries.length > 0 && (
            <SettingsCategoryCard category="tls" entries={tlsEntries} valuesByKey={valuesByKey} onChanged={refetch} />
          )}
        </>
      ) : (
        <p className={styles.helpText}>No network/TLS keys reported by this build.</p>
      )}
      <Link href="/settings/advanced" className={styles.advancedLink}>
        Advanced Server →
      </Link>
    </div>
  );
}
