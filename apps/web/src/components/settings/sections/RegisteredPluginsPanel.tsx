// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/RegisteredPluginsPanel.tsx
//
// LD-8 (owner directive, Settings-Plugins consolidation): the admin Plugins
// list — GET /admin/plugins (bounded, not cursor-paginated, mirrors
// listCrashFiles' own deviation) rendered as status-pill rows
// (lib/plugin-manifest.ts#describePluginStatus, same StatusPill component
// the Jobs/Sessions panels already use), a "Register a plugin" button
// opening RegisterPluginWizard (LPP v1 C4, reused UNCHANGED — this file
// only relocates the list/trigger, never the wizard itself), and each row
// linking to its detail page — MOVED here from the admin Dashboard's
// separate "Plugins" tab (apps/web/src/app/admin/plugins/page.tsx, now a
// redirect-only stub) so registered-plugin management and metadata
// provider keys (ProviderKeysCard, rendered alongside this in
// PluginsSection.tsx) live on the ONE Settings -> Plugins surface.
//
// Sibling-card composition (UsersSection.tsx's InvitesPanel precedent —
// see that file's header: "E2 ... rendered below the user list, this
// lane's layout call"): rendered BELOW the existing ProviderKeysCard in
// PluginsSection.tsx, own hairline separator
// (RegisteredPluginsPanel.module.css, same recipe as InvitesPanel.module
// .css's .panel) rather than folded into that card. Row/list/header shapes
// reuse shared.module.css (the same recipe LibrariesSection/UsersSection/
// InvitesPanel already share) instead of the old admin-route
// page.module.css this list used to import, so this page's list rows look
// identical to every other Settings list row rather than an admin-page
// import surviving in a new home.
//
// Row links now point at /settings/plugins/<id> (this same consolidated
// surface's own detail route — app/settings/plugins/[id]/page.tsx) instead
// of the old /admin/plugins/<id>.
//
// Live updates (unchanged from the pre-move page): subscribes to all 6
// ADMIN_ONLY plugin.* events (apps/server/src/gateway/
// ws-broadcaster.service.ts) and does the SAME cheap GET /admin/plugins
// refetch every other admin surface uses (never trust a locally computed
// post-event state as authoritative).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Blocks } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { EmptyState } from "../../admin/EmptyState.js";
import { StatusPill } from "../../admin/StatusPill.js";
import { RegisterPluginWizard } from "../../admin/plugins/RegisterPluginWizard.js";
import { describePluginStatus } from "../../../lib/plugin-manifest.js";
import { apiGet } from "../../../lib/api-client.js";
import { getEventsSocket } from "../../../lib/events-socket.js";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./shared.module.css";
import panelStyles from "./RegisteredPluginsPanel.module.css";

type AdminPlugin = components["schemas"]["AdminPlugin"];

const LIVE_EVENT_TYPES = [
  "plugin.registered",
  "plugin.updated",
  "plugin.enabled",
  "plugin.disabled",
  "plugin.removed",
  "plugin.health-changed",
];

export function RegisteredPluginsPanel(): React.JSX.Element {
  const [plugins, setPlugins] = useState<AdminPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const refetch = useCallback(() => {
    apiGet("/admin/plugins")
      .then((res) => setPlugins(res.items))
      .catch((err) => setError(apiErrorCopy(err, "Failed to load plugins.")));
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiGet("/admin/plugins")
      .then((res) => {
        if (!cancelled) setPlugins(res.items);
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorCopy(err, "Failed to load plugins."));
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
    <div className={panelStyles.panel}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          Registered plugins{plugins !== null && <span className={styles.countMono}> · {plugins.length}</span>}
        </h2>
        <Button type="button" variant="primary" onClick={() => setRegistering(true)}>
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
              <Link key={plugin.id} href={`/settings/plugins/${plugin.id}`} className={`${styles.row} ${panelStyles.rowLink}`}>
                <div className={styles.rowMain}>
                  <div className={styles.rowText}>
                    <span className={styles.rowTitle}>{plugin.name}</span>
                    <span className={styles.rowSub}>{plugin.baseUrl}</span>
                  </div>
                </div>
                <div className={styles.rowEnd}>
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
    </div>
  );
}
