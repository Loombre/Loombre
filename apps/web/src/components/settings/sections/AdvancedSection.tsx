// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/AdvancedSection.tsx
//
// UIFIX-2026-08-29 Lane K: this file is now a THIN MOUNT. Everything it used
// to own — the registry filter field, the category pill row, the single
// visible category card, and the query-overrides-category selection state —
// was replaced by the three-pane workbench under
// components/settings/advanced/ (AdvancedWorkbench.tsx). The behaviours that
// note used to describe are preserved there, not dropped: a live query still
// OVERRIDES scope rather than combining with it, and picking a scope clears
// the query so the rail can never disagree with the table.
//
// UD-2 (advanced-only): Advanced is the one section that folds the tab
// column into its own page title (SectionSwitcher). app/settings/advanced/
// page.tsx therefore mounts this component directly instead of going through
// SettingsShell, which would wrap it in SettingsTabs + SettingsPageLayout's
// readable-width cap — both wrong for a three-pane workbench. The nine other
// sections keep SettingsShell exactly as it is; that file is untouched.
//
// The admin guard lives here rather than in the route so BOTH entry points
// are covered — this component is still reachable through SettingsShell's
// renderSection("advanced") branch, which does its own guard.

import { useAdminGuard } from "../../../lib/use-admin-guard.js";
import { AdvancedWorkbench } from "../advanced/AdvancedWorkbench.js";

export interface AdvancedSectionProps {
  /** SettingsShell's per-section heading. Unused here: the workbench's own
   *  <h1> IS the section switcher and takes its label from
   *  section-registry.ts directly, so a second heading would duplicate it. */
  heading?: string | null;
}

export function AdvancedSection(_props: AdvancedSectionProps): React.JSX.Element | null {
  const { isAdmin } = useAdminGuard("/profile");
  if (isAdmin !== true) return null; // resolving, or already redirecting
  return <AdvancedWorkbench />;
}
