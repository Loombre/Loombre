// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Blocks, Briefcase, Monitor, Video } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import styles from "./AdminNav.module.css";

// Settings-IA unification (W2 L1): Libraries, Users, and Settings (the
// registry) moved out of this admin sub-nav into the unified /settings
// surface (/settings/libraries, /settings/users, /settings/advanced —
// components/settings/SettingsShell.tsx). /admin/libraries, /admin/users,
// and /admin/settings still work (redirect-only stubs to their new homes)
// but are no longer linked from here. "Plugins" here is the LOOMBRE PLUGIN
// PROTOCOL registration surface (RegisterPluginWizard etc.) — an unrelated
// system from the Settings "Plugins" tab (metadata-provider API keys, now
// at /settings/plugins); the shared label is a real naming collision that
// lane logged but did not rename (out of scope — see its freeze report).
//
// "Dashboard" (Phosphor retheme Wave 2, Lane L2) is an EXACT-match route
// ("/admin" itself, not a prefix) — every other tab below it lives under
// "/admin/*" and would ALSO satisfy a naive `pathname.startsWith("/admin")`
// check, so Dashboard needs its own equality test rather than the shared
// startsWith one every other section uses.
const DASHBOARD_HREF = "/admin";
const SECTIONS = [
  { href: "/admin/jobs", icon: Briefcase, label: "Jobs" },
  { href: "/admin/sessions", icon: Video, label: "Sessions" },
  { href: "/admin/plugins", icon: Blocks, label: "Plugins" },
  { href: "/admin/system", icon: Monitor, label: "System" },
];

export function AdminNav(): React.JSX.Element {
  const pathname = usePathname();
  return (
    <nav className={styles.nav} aria-label="Admin sections">
      <Link href={DASHBOARD_HREF} className={styles.link} data-active={pathname === DASHBOARD_HREF}>
        <Icon icon="dashboard" size="dense" />
        Dashboard
      </Link>
      {SECTIONS.map(({ href, icon, label }) => (
        <Link key={href} href={href} className={styles.link} data-active={pathname?.startsWith(href)}>
          <Icon icon={icon} size="dense" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
