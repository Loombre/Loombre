// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/admin/page.tsx
//
// The Phosphor admin dashboard (Phosphor retheme Wave 2, Lane L2 —
// design/phosphor/README.md "Screens → Admin dashboard" +
// "Interactions & behavior → Scanning"). Replaces the former redirect-to-
// /admin/jobs stub — this IS the "Dashboard" destination now (AdminNav
// gained its own tab pointing here).
//
// Layout: four (well — one, see HealthCards.tsx's own header) health
// cards; a two-column body — left column ACTIVE STREAMS (StreamsPanel) +
// LIBRARIES (LibrariesPanel, with the Fix Match flow wired in); right
// column a collapsible job queue (JobsPanel, reused verbatim from
// app/admin/jobs/page.tsx) and a collapsible event log (EventLogPanel,
// client-side ring buffer over the shared events socket) — reflowing the
// EXISTING jobs/events surfaces rather than rebuilding them, per the task
// brief. Mobile (<=767.98px): the body stacks to one column; the health
// card grid becomes 2-up (HealthCards.module.css).
//
// GAP logged, never fabricated (U9): "users online" (right column,
// presence dots) has NO backing feed — the events socket delivers outbox
// events + a synthesized restricted.locked signal, never a connect/
// disconnect broadcast or an online-users query anywhere in the contract
// (ground-truthed apps/server/src/gateway/ws-broadcaster.service.ts and
// packages/contract/openapi.yaml). Omitted entirely per the task brief's
// own instruction ("users online... if a feed exists — else omit+log").
//
// H19 (W3 fidelity audit): "Dashboard" header + mono status line, REAL
// /system/info fields only (version, uptime) — dc:582's own literal is
// `LOOMBRE-01 · V0.9.2 · UP 14D 6H · POSTGRES OK`; `LOOMBRE-01` is a
// fixture hostname with no source anywhere (SystemInfo has no `name`/
// `hostname` field — ground-truthed against packages/contract/
// openapi.yaml), and "POSTGRES OK" has no backing signal either (no
// postgres field on SystemInfo; the only DB-adjacent probe, GET
// /healthz, is a bare liveness stub — `{status:"ok",timestampMs}`, zero
// DB/subsystem check, per apps/server/src/gateway/health.controller.ts).
// Both omitted, not fabricated. The dc's pulsing "ALL SYSTEMS NOMINAL"
// dot is omitted for the same reason: no real health signal is wired
// into the web client to back it (a /healthz fetch would only prove
// "the Node process is up," not "all systems," and no component on this
// page today calls it) — logged here rather than added as a decorative,
// unbacked pulse.

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { HealthCards } from "../../components/admin/HealthCards.js";
import { StreamsPanel } from "../../components/admin/StreamsPanel.js";
import { LibrariesPanel } from "../../components/admin/LibrariesPanel.js";
import { JobsPanel } from "../../components/admin/JobsPanel.js";
import { EventLogPanel } from "../../components/admin/EventLogPanel.js";
import { Card } from "../../components/ui/Card.js";
import { apiGet } from "../../lib/api-client.js";
import styles from "./page.module.css";

type SystemInfo = components["schemas"]["SystemInfo"];

function formatUptime(uptimeMs: number | null | undefined): string | null {
  if (uptimeMs == null) return null;
  const totalMinutes = Math.floor(uptimeMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `UP ${days}D ${hours}H`;
  if (hours > 0) return `UP ${hours}H ${minutes}M`;
  return `UP ${minutes}M`;
}

function DashboardHeader(): React.JSX.Element {
  const [info, setInfo] = useState<SystemInfo | null>(null);

  useEffect(() => {
    apiGet("/system/info")
      .then(setInfo)
      .catch(() => {
        // Best-effort status line — the dashboard itself already renders
        // without it; no error banner for a decorative mono readout.
      });
  }, []);

  const uptime = formatUptime(info?.uptimeMs);

  return (
    <div className={styles.headerRow}>
      <h1 className={styles.heading}>Dashboard</h1>
      {info && (
        <span className={styles.statusLine}>
          V{info.version}
          {uptime ? ` · ${uptime}` : ""}
        </span>
      )}
    </div>
  );
}

export default function AdminDashboardPage(): React.JSX.Element {
  return (
    <div className={styles.page}>
      <DashboardHeader />

      <HealthCards />

      <div className={styles.body}>
        <div className={styles.column}>
          <Card>
            <StreamsPanel />
          </Card>
          <Card>
            <LibrariesPanel />
          </Card>
        </div>

        <div className={styles.column}>
          {/* "Users online" — omitted, no presence feed exists (see this
              file's header). */}
          <details className={styles.collapsibleCard} open>
            <summary className={styles.collapsibleSummary}>Job queue</summary>
            <div className={styles.collapsibleBody}>
              <JobsPanel maxHeight={360} showHeader={false} />
            </div>
          </details>

          <details className={styles.collapsibleCard}>
            <summary className={styles.collapsibleSummary}>Event log</summary>
            <div className={styles.collapsibleBody}>
              <EventLogPanel isAdmin />
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
