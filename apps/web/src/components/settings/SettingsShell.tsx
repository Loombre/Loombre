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
//   - Desktop (> 767.98px): pill tabs (SettingsTabs, README "200px pill
//     tab list") + a content pane (SettingsPageLayout.tsx — W7/D-4: a
//     readable ~1120px max width, CENTERED in the space right of the tab
//     column rather than left-hugging it; see that file's header for the
//     defect this replaced) — regardless of which /settings* URL rendered
//     the page (a deep link to /settings/libraries still shows the full
//     tab chrome with Libraries active).
//   - Mobile (<= 767.98px): the grouped hub list (SettingsHub) at bare
//     /settings, or — at a /settings/<key> route — just that section's own
//     content, full-bleed (the shell's MobileHeader already supplies the
//     "back chevron to Settings" chrome for these routes via
//     mobile-header.ts's settingsSection branch; nothing here duplicates
//     it).
//
// D-6 (Wave 2, this run — IA restructure): every SETTINGS_SECTIONS entry is
// now adminOnly (section-registry.ts's own header) — the former non-admin
// "Account" section moved out to its own route, /profile
// (components/profile/ProfileSettings.tsx), reached from the avatar menu.
// SettingsShell therefore now gates ALL of /settings* on isAdmin: a
// non-admin hitting bare /settings OR any /settings/<key> URL is redirected
// straight to /profile — the direct descendant of this file's PRE-D-6
// posture ("requesting an admin-only section as a non-admin redirects to
// bare /settings, where their one section lives"), just pointed at the new
// home for that content now that bare /settings has nothing of theirs left
// to show. This mirrors app/admin/layout.tsx's existing UX-only admin guard
// (the real boundary is server-side: every admin endpoint these sections
// call independently 403s a non-admin token — see
// apps/server/test/settings-authz.e2e.spec.ts).
//
// Duplicate-title cleanup (pre-D-6 lane brief, still honored): `heading`
// passed to each section is a real string in every case reached here now
// (there is no more non-admin bare-/settings branch to special-case to
// null) — see each section's own file for why it needs one.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "../../lib/api-client.js";
import { useMediaQuery } from "../ui/use-media-query.js";
import { sectionByKey, type SettingsSectionKey } from "./section-registry.js";
import { SettingsTabs } from "./SettingsTabs.js";
import { SettingsHub } from "./SettingsHub.js";
import { SettingsPageLayout } from "./SettingsPageLayout.js";
import { ServerSection } from "./sections/ServerSection.js";
import { NoticesSection } from "./sections/NoticesSection.js";
import { LibrariesSection } from "./sections/LibrariesSection.js";
import { UsersSection } from "./sections/UsersSection.js";
import { PlaybackSection } from "./sections/PlaybackSection.js";
import { RemoteAccessSection } from "./sections/RemoteAccessSection.js";
import { PluginsSection } from "./sections/PluginsSection.js";
import { MailSection } from "./sections/MailSection.js";
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
    case "server":
      return <ServerSection heading={heading} />;
    case "notices":
      return <NoticesSection heading={heading} />;
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
    case "mail":
      return <MailSection heading={heading} />;
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

  // D-6: every section is admin-only now (section-registry.ts) — a
  // non-admin has nothing left to see anywhere under /settings*, so this
  // redirects unconditionally rather than only for a subset of keys.
  useEffect(() => {
    if (isAdmin === false) router.replace("/profile");
  }, [isAdmin, router]);

  if (isAdmin === null) return null; // resolving /users/me
  if (!isAdmin) return null; // redirecting to /profile, see effect above

  const activeKey: SettingsSectionKey = initialSection ?? "server";
  const heading = sectionByKey(activeKey)?.label ?? "Settings";

  if (isPhone) {
    if (initialSection === null) return <SettingsHub />;
    return renderSection(activeKey, heading);
  }

  return (
    <div className={styles.shell}>
      <SettingsTabs active={activeKey} />
      {/* W7/D-4: SettingsPageLayout (not a local `.pane`) owns the
          readable-max-width + centered-in-remaining-space contract now —
          see its header for why the old 760px `.pane` stacked with every
          section's own `.page` max-width to produce the reported
          left-hugging/dead-right-margin defect. */}
      <SettingsPageLayout>{renderSection(activeKey, heading)}</SettingsPageLayout>
    </div>
  );
}
