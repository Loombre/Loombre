// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/settings/SettingsPageLayout.tsx
//
// W7 (locked decision D-4): the ONE shared content-width primitive for
// every settings/admin content area, replacing a per-page CSS pattern that
// caused the reported defect (owner screenshots of nearly every settings/
// admin page — Server, Playback, Plugins, Mail, Advanced Server, Account,
// System — showing a narrow left-hugging column with ~40% of the viewport
// dead on the right).
//
// Root cause, ground-truthed: TWO independent width caps stacked. Every
// section's own module.css redeclared its own `max-width` (640px, some
// 760px) on its root `.page`/`.wrap` class, INSIDE SettingsShell.module.css's
// own `.pane` (also capped, at 760px) — the narrower of the two always won,
// and neither one was ever centered in the remaining space, so the gap
// between the capped column and the actual (much wider) content area just
// sat empty. admin/layout.module.css's `.page` had the same problem on its
// own: a `max-width` with no `margin: auto`, so it hugged the left edge of
// `<main>` instead of centering.
//
// This component owns BOTH halves of the fix, everywhere, from one place:
//   - a readable max width (~1100-1200px — form/registry content stops
//     getting meaningfully more readable past this, per the locked
//     requirement), and
//   - centering that column in whatever horizontal space its caller hands
//     it, rather than left-hugging.
//
// Deliberately unopinionated about its parent's layout mode so ONE
// component works in both real call sites:
//   - SettingsShell.tsx's desktop pane: a ROW flex item sitting to the
//     right of the 200px SettingsTabs column — `flex: 1 1 0%` here lets it
//     grow to fill that remaining row width (a no-op outside a flex
//     container, so this doesn't fight the other call site below).
//   - admin/layout.tsx's page body and the two standalone /settings/data
//     and /settings/devices routes (page.tsx headers explain why those
//     don't route through SettingsShell): plain block content under
//     AppShell's <main> — `width: 100%` governs sizing there instead.
//
// Every consumer's own module.css must NOT redeclare a competing
// `max-width` on its content root anymore — that reintroduces exactly the
// double-cap bug this component exists to fix. Sectioned content keeps its
// own `display:flex;flex-direction:column;gap:...` shape; only the width
// cap and centering move here.

import type { ReactNode } from "react";
import styles from "./SettingsPageLayout.module.css";

export function SettingsPageLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className={styles.layout}>
      <div className={styles.inner}>{children}</div>
    </div>
  );
}
