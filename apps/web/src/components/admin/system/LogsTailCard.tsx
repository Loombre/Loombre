// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/system/LogsTailCard.tsx
//
// D-5 (Wave 2, this run — IA restructure): extracted from the deleted
// app/admin/system/page.tsx, now composed on the merged Dashboard
// (app/admin/page.tsx) instead. Same GET /admin/logs/tail endpoint, same
// lines-selector + auto-refresh-toggle behavior (poll, no socket, per the
// original task brief) — UNCHANGED except for W12's empty-state copy
// rewrite below.
//
// EMPTY-STATE COPY HISTORY (W12 -> W3-R -> LD-11): originally read
// "LOOMBRE_LOG_FILE isn't set on this instance — stdout-only dev setups
// have nothing to tail here" (developer-speak aimed at a Loombre engineer,
// not the actual audience). W3-R (opus review) caught that the REPLACEMENT
// copy claimed installers "configure a log file automatically" while at
// the time NONE did — installers only captured console output at the
// service-manager level (macOS launchd StandardOutPath, Windows service
// host, systemd journal), so every install shape hit this card. LD-11
// (this implementation run's lane B3) makes that claim TRUE:
// every shipped install shape (macOS pkg, Windows MSI, Docker, Linux
// tarball) now sets LOOMBRE_LOG_FILE to a real, already-populated log path
// (see installers/macos/pkg/bin/loombre-server, installers/windows/msi/
// Services.wxs, docker-compose.prod.yml, installers/linux/
// build-tarball.mjs's writeWrapperScripts). `source === null` (this
// card's empty state) is now primarily a DEV/SOURCE-RUN signal — `pnpm
// dev` and other from-source invocations still have nothing set, by
// design, and this state must keep handling that gracefully rather than
// implying something is broken. Copy below states BOTH facts plainly:
// installed builds handle this automatically; a source run is expected to
// land here and can opt in locally. Env var name stays demoted to a
// small, secondary "Technical:" line (.technicalNote) rather than removed
// entirely, plus one sentence linking to the docs page that covers it
// (docs/ops/env-reference.md, the only page in the docs site that names
// LOOMBRE_LOG_FILE at all — ground-truthed by grepping docs/ before
// picking a target).

import { useState } from "react";
import { useEffect } from "react";
import { Card } from "../../ui/Card.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { EmptyState } from "../EmptyState.js";
import { apiGet } from "../../../lib/api-client.js";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./system-cards.module.css";
import { FolderOpen } from "lucide-react";

const LINES_OPTIONS = ["50", "200", "500"];
const AUTO_REFRESH_INTERVAL_MS = 5000;
const ENV_REFERENCE_DOCS_URL = "https://loombre.com/docs/ops/env-reference";

export function LogsTailCard(): React.JSX.Element {
  const [lines, setLines] = useState(200);
  const [source, setSource] = useState<string | null | undefined>(undefined);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load(currentLines: number): void {
    apiGet("/admin/logs/tail", { params: { query: { lines: currentLines } } })
      .then((res) => {
        setSource(res.source);
        setLogLines(res.lines);
      })
      .catch((err) => setError(apiErrorCopy(err, "Failed to load logs.")));
  }

  useEffect(() => {
    load(lines);
  }, [lines]);

  // Auto-refresh: POLLS on a fixed interval — no websocket, per the task
  // brief ("logs tail with lines selector + auto-refresh toggle (poll, no
  // socket)").
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => load(lines), AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, lines]);

  return (
    <Card>
      <div className={styles.header}>
        <h2 className={styles.cardTitle}>Log tail</h2>
        <div className={styles.logControls}>
          <SegmentedControl options={LINES_OPTIONS} defaultValue="200" onChange={(v) => setLines(Number.parseInt(v, 10))} />
          <label className={styles.autoRefreshToggle}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh
          </label>
        </div>
      </div>
      {error && <p className={styles.errorText}>{error}</p>}
      {source === undefined ? (
        <Skeleton radius="md" height={120} />
      ) : source === null ? (
        <>
          {/* LD-11: installed builds (macOS/Windows/Docker/Linux tarball)
              set LOOMBRE_LOG_FILE automatically now, so this state mainly
              means "running from source" — see this file's header for the
              full copy history. Still needs to degrade gracefully for that
              case: never implies something is broken, and gives a real
              next step for a developer who wants it locally. */}
          <EmptyState
            icon={FolderOpen}
            title="No log file to show here"
            body="This server isn't writing its logs to a file right now. Installed builds (macOS, Windows, Docker, and the Linux tarball) set this up automatically — if you're seeing this on one of those, check that the service is actually running as installed. Running from source (for example, a plain development server) doesn't set this by default, which is expected. Either way, set the LOOMBRE_LOG_FILE setting to a file path and restart to see logs here."
          />
          <p className={styles.technicalNote}>Technical: LOOMBRE_LOG_FILE is not set on this instance.</p>
          <a href={ENV_REFERENCE_DOCS_URL} target="_blank" rel="noreferrer noopener" className={styles.notesLink}>
            Environment reference
          </a>
        </>
      ) : (
        <>
          <p className={styles.helpText}>Source: {source}</p>
          <pre className={styles.logContent}>{logLines.length > 0 ? logLines.join("\n") : "(empty)"}</pre>
        </>
      )}
    </Card>
  );
}
