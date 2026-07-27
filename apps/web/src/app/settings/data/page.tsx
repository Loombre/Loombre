// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/data/page.tsx
//
// GET /export (data-freedom archive download, docs/PLAN.md §8.4, P12) had
// zero UI anywhere in apps/web — see ../../../components/data-freedom/
// ExportDataCard.tsx's header for the full defect writeup (77-agent
// review). This route is the missing entry point.
//
// Deliberately NOT one of SettingsShell's tab/hub sections: section-
// registry.ts's SettingsSectionKey union has no "data" member, and adding
// one (plus a hub row / nav link pointing here) touches
// components/settings/section-registry.ts and SettingsHub.tsx/
// SettingsTabs.tsx — nav files outside this fix's owned paths (apps/web/
// src/app/settings/data/** and components/data-freedom/** only). This page
// stands alone with its own minimal AppShell chrome instead of
// SettingsShell, and is reachable today by direct URL/bookmark until a
// settings-IA-owning change wires a real link to it (see this fix's notes
// for exactly where that belongs).
//
// GET /export is authenticated-but-not-admin (data-freedom.controller.ts's
// own header), so — unlike every other /settings/<key> route, which is
// admin-only apart from "account" — this page has no admin gate: every
// signed-in user is entitled to their own data.

import { AppShell } from "../../../components/shell/AppShell.js";
import { ExportDataCard } from "../../../components/data-freedom/ExportDataCard.js";
import styles from "./page.module.css";

export default function SettingsDataPage(): React.JSX.Element {
  return (
    <AppShell>
      <div className={styles.page}>
        <h1 className={styles.heading}>Data</h1>
        <ExportDataCard />
      </div>
    </AppShell>
  );
}
