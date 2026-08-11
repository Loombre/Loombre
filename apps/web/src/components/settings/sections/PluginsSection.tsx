// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/PluginsSection.tsx
//
// README tab 6 "Plugins": metadata provider cards (TMDB/TVDB) with
// write-only API-key management. This is the TAB SLOT + navigation this
// lane owns — the actual card (components/admin/settings/ProviderKeysCard)
// is sibling lane L6's internals, reused here completely UN-RESTYLED (see
// this lane's scope note: "do NOT restyle registry/provider-key
// components"). Previously rendered bundled together with the registry on
// one /admin/settings page; split into its own tab/route here so it can be
// reached independently of Advanced Server, matching the README's 8
// distinct tabs.
//
// LD-8 (owner directive, Settings-Plugins consolidation): this tab now ALSO
// hosts registered-plugin management (RegisteredPluginsPanel — list +
// "Register a plugin", moved here from the admin Dashboard's separate
// "Plugins" tab, retired in AdminNav.tsx), rendered as a sibling card below
// ProviderKeysCard (same "sibling card below the primary list" composition
// UsersSection.tsx uses for InvitesPanel). What used to be a genuine naming
// collision between this tab and the unrelated /admin/plugins Loombre
// Plugin Protocol surface (see git blame / STATE.md for that era's logged
// collision) is resolved by this move: there is now exactly one "Plugins"
// surface, here, and /admin/plugins is a redirect-only stub into it.

import { ProviderKeysCard } from "../../admin/settings/ProviderKeysCard.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { RegisteredPluginsPanel } from "./RegisteredPluginsPanel.js";
import { useAdminSettingsData } from "./use-admin-settings-data.js";
import styles from "./PluginsSection.module.css";

export function PluginsSection({ heading }: { heading: string | null }): React.JSX.Element {
  const { settings, error, refetch } = useAdminSettingsData();

  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}
      {error && <p className={styles.errorText}>{error}</p>}
      {!settings ? <Skeleton radius="lg" height={160} /> : <ProviderKeysCard statuses={settings.providerKeys} onChanged={refetch} />}
      <RegisteredPluginsPanel />
    </div>
  );
}
