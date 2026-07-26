// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/SettingsShell.tsx
//
// Wave 2 lane L1: the ONE responsive component (U2) behind every
// /settings* route — bare /settings (the hub/default-tab host) and every
// /settings/<key> drill-down route (section-registry.ts) all render this
// exact same component, parameterized by `initialSection`. A `matchMedia`
// read (useMediaQuery, the same legitimate viewport-measurement escape
// hatch SheetOrModal.tsx already uses — not user-agent branching) picks
// which of the two RESPONSIVE FORMS to show:
//   - Desktop (> 767.98px): pill tabs (SettingsTabs) + a 760px content
//     pane, matching README "Settings. 200px pill tab list + a 760px
//     max-width pane" — literally, regardless of which /settings* URL
//     rendered the page (a deep link to /settings/libraries still shows
//     the full tab chrome with Libraries active).
//   - Mobile (<= 767.98px): the grouped hub list (SettingsHub) at bare
//     /settings, or — at a /settings/<key> route — just that section's own
//     content, full-bleed (the shell's MobileHeader already supplies the
//     "back chevron to Settings" chrome for these routes via
//     mobile-header.ts's settingsSection branch; nothing here duplicates
//     it).
//
// Non-admins (isAdmin === false) see ONLY the Account section, unchanged
// from every non-admin's existing capability pre-Wave-2 — no tabs, no hub,
// zero regression (this lane's brief: "map existing capability... WITHOUT
// breaking existing routes"). Requesting any OTHER section's route as a
// non-admin redirects to bare /settings, mirroring app/admin/layout.tsx's
// existing UX-only admin guard (the real boundary is server-side: every
// admin endpoint these sections call independently 403s a non-admin token).
//
// Duplicate-title cleanup (this lane's brief): `heading` passed to each
// section is null in EXACTLY one case — non-admin, phone width, bare
// /settings — because MobileHeader (mobile-header.ts's `/settings` exact
// match) already renders a large "Settings" title there; re-rendering the
// same text in-page would be the literal bug this lane was asked to fix.
// Every other case (desktop panes, admin mobile drill-down routes, and the
// non-admin desktop case where nothing else renders a title) gets a real
// heading — see each section's own file for why it needs one.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "../../lib/api-client.js";
import { useMediaQuery } from "../ui/use-media-query.js";
import { sectionByKey, type SettingsSectionKey } from "./section-registry.js";
import { SettingsTabs } from "./SettingsTabs.js";
import { SettingsHub } from "./SettingsHub.js";
import { AccountSection } from "./sections/AccountSection.js";
import { ServerSection } from "./sections/ServerSection.js";
import { LibrariesSection } from "./sections/LibrariesSection.js";
import { UsersSection } from "./sections/UsersSection.js";
import { PlaybackSection } from "./sections/PlaybackSection.js";
import { RemoteAccessSection } from "./sections/RemoteAccessSection.js";
import { PluginsSection } from "./sections/PluginsSection.js";
import { AdvancedSection } from "./sections/AdvancedSection.js";
import { AboutSection } from "./sections/AboutSection.js";
import styles from "./SettingsShell.module.css";

const PHONE_QUERY = "(max-width: 767.98px)";

export interface SettingsShellProps {
  /** null at bare /settings; a specific key at /settings/<key>. */
  initialSection: SettingsSectionKey | null;
}

function renderSection(key: SettingsSectionKey, heading: string | null): React.JSX.Element {
  switch (key) {
    case "account":
      return <AccountSection heading={heading} />;
    case "server":
      return <ServerSection heading={heading} />;
    case "libraries":
      return <LibrariesSection heading={heading} />;
    case "users":
      return <UsersSection heading={heading} />;
    case "playback":
      return <PlaybackSection heading={heading} />;
    case "remote-access":
      return <RemoteAccessSection heading={heading} />;
    case "plugins":
      return <PluginsSection heading={heading} />;
    case "advanced":
      return <AdvancedSection heading={heading} />;
    case "about":
      return <AboutSection heading={heading} />;
  }
}

export function SettingsShell({ initialSection }: SettingsShellProps): React.JSX.Element | null {
  const router = useRouter();
  const isPhone = useMediaQuery(PHONE_QUERY);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet("/users/me")
      .then((u) => {
        if (!cancelled) setIsAdmin(u.isAdmin === true);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const requestedAdminOnlySection = initialSection !== null && initialSection !== "account";

  useEffect(() => {
    if (isAdmin === false && requestedAdminOnlySection) router.replace("/settings");
  }, [isAdmin, requestedAdminOnlySection, router]);

  if (isAdmin === null) return null; // resolving /users/me
  if (!isAdmin) {
    if (requestedAdminOnlySection) return null; // redirecting, see effect above
    return <AccountSection heading={isPhone ? null : "Settings"} />;
  }

  const activeKey: SettingsSectionKey = initialSection ?? "account";
  const heading = sectionByKey(activeKey)?.label ?? "Settings";

  if (isPhone) {
    if (initialSection === null) return <SettingsHub />;
    return renderSection(activeKey, heading);
  }

  return (
    <div className={styles.shell}>
      <SettingsTabs active={activeKey} />
      <div className={styles.pane}>{renderSection(activeKey, heading)}</div>
    </div>
  );
}
