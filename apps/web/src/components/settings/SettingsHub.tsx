// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/SettingsHub.tsx
//
// Mobile Settings hub (README "Phone-only additions... Settings hub — an
// inset grouped list of the ten sections with sub-labels and badges
// (LIVE, key count, provider count), instead of the desktop's side tabs").
// Rendered by SettingsShell.tsx only for admins at bare /settings on a
// phone-width viewport; non-admins never see this (they have exactly one
// section, rendered directly with no hub — see SettingsShell's header).
//
// Every badge below is DERIVED live from a real endpoint on mount, never
// stored/cached across renders — this is the exact discipline the
// README's State-management section calls out by name ("Note the two
// flags that must be derived, not stored: user count and restricted-
// profile count. Storing them is how the prototype's mobile subtitle went
// stale.") applied to every badge here, not just those two:
//   - Libraries: item count from GET /libraries, OR a live "LIVE" pill
//     (amber, pulsing) while use-library-scan-status.ts's socket
//     subscription reports any library mid-scan this session — the same
//     scan.started/scan.completed events Sidebar.tsx's SCAN badge uses.
//   - Users & Profiles: count from GET /users.
//   - Plugins: how many of the metadata provider keys are set, from GET
//     /admin/settings's `providerKeys`.
//   - Advanced Server: total registry key count from GET
//     /admin/settings/schema.
//   - About: this build's version, from GET /system/info.
// Server, Playback, Remote Access, and Account carry no badge — there is
// no single real number that summarizes any of them honestly.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Icon } from "../icon/Icon.js";
import { apiGet } from "../../lib/api-client.js";
import { getEventsSocket } from "../../lib/events-socket.js";
import { SETTINGS_SECTIONS, type SettingsSectionKey } from "./section-registry.js";
import styles from "./SettingsHub.module.css";

type SystemInfo = components["schemas"]["SystemInfo"];

interface HubBadges {
  librariesCount: number | null;
  librariesScanning: boolean;
  usersCount: number | null;
  providerKeysSet: number | null;
  providerKeysTotal: number | null;
  registryKeyCount: number | null;
  version: string | null;
}

function useHubBadges(): HubBadges {
  const [state, setState] = useState<HubBadges>({
    librariesCount: null,
    librariesScanning: false,
    usersCount: null,
    providerKeysSet: null,
    providerKeysTotal: null,
    registryKeyCount: null,
    version: null,
  });

  useEffect(() => {
    let cancelled = false;

    apiGet("/libraries", { params: { query: { limit: 200 } } })
      .then((page) => {
        if (!cancelled) setState((prev) => ({ ...prev, librariesCount: page.items.length }));
      })
      .catch(() => undefined);

    apiGet("/users", { params: { query: { limit: 200 } } })
      .then((page) => {
        if (!cancelled) setState((prev) => ({ ...prev, usersCount: page.items.length }));
      })
      .catch(() => undefined);

    apiGet("/admin/settings")
      .then((res) => {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            providerKeysSet: res.providerKeys.filter((k) => k.set).length,
            providerKeysTotal: res.providerKeys.length,
          }));
        }
      })
      .catch(() => undefined);

    apiGet("/admin/settings/schema")
      .then((res) => {
        if (!cancelled) setState((prev) => ({ ...prev, registryKeyCount: res.entries.length }));
      })
      .catch(() => undefined);

    apiGet("/system/info")
      .then((info: SystemInfo) => {
        if (!cancelled) setState((prev) => ({ ...prev, version: info.version }));
      })
      .catch(() => undefined);

    const socket = getEventsSocket();
    const scanning = new Set<string>();
    const unsubStarted = socket.subscribe<{ jobId: string }>("scan.started", (e) => {
      scanning.add(e.payload.jobId);
      if (!cancelled) setState((prev) => ({ ...prev, librariesScanning: scanning.size > 0 }));
    });
    const unsubCompleted = socket.subscribe<{ jobId: string }>("scan.completed", (e) => {
      scanning.delete(e.payload.jobId);
      if (!cancelled) setState((prev) => ({ ...prev, librariesScanning: scanning.size > 0 }));
    });

    return () => {
      cancelled = true;
      unsubStarted();
      unsubCompleted();
    };
  }, []);

  return state;
}

function badgeFor(key: SettingsSectionKey, badges: HubBadges): { text: string; live: boolean } | null {
  switch (key) {
    case "libraries":
      if (badges.librariesScanning) return { text: "LIVE", live: true };
      if (badges.librariesCount !== null) return { text: `${badges.librariesCount}`, live: false };
      return null;
    case "users":
      return badges.usersCount !== null ? { text: `${badges.usersCount}`, live: false } : null;
    case "plugins":
      return badges.providerKeysSet !== null && badges.providerKeysTotal !== null
        ? { text: `${badges.providerKeysSet}/${badges.providerKeysTotal}`, live: false }
        : null;
    case "advanced":
      return badges.registryKeyCount !== null ? { text: `${badges.registryKeyCount} keys`, live: false } : null;
    case "about":
      return badges.version !== null ? { text: `v${badges.version}`, live: false } : null;
    default:
      return null;
  }
}

export function SettingsHub(): React.JSX.Element {
  const badges = useHubBadges();

  return (
    <div className={styles.hub}>
      <div className={styles.group}>
        {SETTINGS_SECTIONS.map((section) => {
          const badge = badgeFor(section.key, badges);
          return (
            <Link key={section.key} href={section.href} className={styles.row}>
              <span className={styles.rowLabel}>{section.label}</span>
              <span className={styles.rowEnd}>
                {badge && (
                  <span className={styles.badge} data-live={badge.live}>
                    {badge.live && <span className={styles.liveDot} aria-hidden="true" />}
                    {badge.text}
                  </span>
                )}
                <Icon icon={ChevronRight} size="dense" className={styles.chevron ?? ""} />
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
