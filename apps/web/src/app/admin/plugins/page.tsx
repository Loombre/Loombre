// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/admin/plugins/page.tsx
//
// LPP v1, Lane W5: the admin Plugins list — GET /admin/plugins (bounded,
// not cursor-paginated, mirrors listCrashFiles' own deviation) rendered as
// status-pill rows (lib/plugin-manifest.ts#describePluginStatus, same
// StatusPill component the Jobs/Sessions panels already use), a "Register
// a plugin" button opening RegisterPluginWizard (C4), and each row linking
// to its detail page.
//
// Live updates (mission spec): subscribes to all 6 ADMIN_ONLY plugin.*
// events (apps/server/src/gateway/ws-broadcaster.service.ts) and does the
// SAME cheap GET /admin/plugins refetch every other admin page uses
// (settings/page.tsx's own documented reasoning: never trust a locally
// computed post-event state as authoritative).
//
// Code-split like every other /admin/* route — see admin/settings/page.tsx's
// header for why this keeps the /browse route's perf budget untouched.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Blocks } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Card } from "../../../components/ui/Card.js";
import { Button } from "../../../components/ui/Button.js";
import { Skeleton } from "../../../components/skeleton/Skeleton.js";
import { EmptyState } from "../../../components/admin/EmptyState.js";
import { StatusPill } from "../../../components/admin/StatusPill.js";
import { RegisterPluginWizard } from "../../../components/admin/plugins/RegisterPluginWizard.js";
import { describePluginStatus } from "../../../lib/plugin-manifest.js";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import { getEventsSocket } from "../../../lib/events-socket.js";
import styles from "./page.module.css";

type AdminPlugin = components["schemas"]["AdminPlugin"];

const LIVE_EVENT_TYPES = [
  "plugin.registered",
  "plugin.updated",
  "plugin.enabled",
  "plugin.disabled",
  "plugin.removed",
  "plugin.health-changed",
];

export default function AdminPluginsPage(): React.JSX.Element {
  const [plugins, setPlugins] = useState<AdminPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const refetch = useCallback(() => {
    apiGet("/admin/plugins")
      .then((res) => setPlugins(res.items))
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load plugins."));
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiGet("/admin/plugins")
      .then((res) => {
        if (!cancelled) setPlugins(res.items);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof LoombreApiError ? err.message : "Failed to load plugins.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const socket = getEventsSocket();
    const unsubscribes = LIVE_EVENT_TYPES.map((type) => socket.subscribe(type, () => refetch()));
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [refetch]);

  return (
    <Card>
      <div className={styles.header}>
        <h2 className={styles.title}>Plugins</h2>
        <Button variant="primary" onClick={() => setRegistering(true)}>
          Register a plugin
        </Button>
      </div>

      {error && <p className={styles.errorBanner}>{error}</p>}

      {plugins === null ? (
        <div className={styles.skeletonList} aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} radius="md" height={56} />
          ))}
        </div>
      ) : plugins.length === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No plugins registered"
          body="Register a plugin to add metadata sources or send Loombre's activity feed somewhere."
        />
      ) : (
        <div className={styles.list}>
          {plugins.map((plugin) => {
            const status = describePluginStatus(plugin);
            return (
              <Link key={plugin.id} href={`/admin/plugins/${plugin.id}`} className={styles.pluginRow}>
                <div className={styles.pluginMain}>
                  <span className={styles.pluginName}>{plugin.name}</span>
                  <span className={styles.pluginUrl}>{plugin.baseUrl}</span>
                </div>
                <div className={styles.rowMeta}>
                  <StatusPill label={status.label} tone={status.tone} />
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {registering && (
        <RegisterPluginWizard
          onClose={() => setRegistering(false)}
          onRegistered={() => {
            setRegistering(false);
            refetch();
          }}
        />
      )}
    </Card>
  );
}
