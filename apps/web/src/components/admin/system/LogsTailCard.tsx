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
// W12 (this run): the "no log file" empty state used to read
// "LOOMBRE_LOG_FILE isn't set on this instance — stdout-only dev setups
// have nothing to tail here" — developer-speak (an env var name as the
// SUBJECT of the sentence, "dev setups" jargon) aimed at a Loombre engineer
// debugging their own dev box, not at the actual audience: an operator
// running a real, installed Loombre server who has no idea what
// LOOMBRE_LOG_FILE is. Rewritten so the PLAIN-LANGUAGE explanation
// (EmptyState's body) leads — what's happening and why installed setups
// don't normally hit this — with the env var name demoted to a small,
// secondary "Technical:" line (.technicalNote) rather than removed
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
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
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
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load logs."));
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
          <EmptyState
            icon={FolderOpen}
            title="No log file to show"
            body="This server is currently writing its logs to console output rather than a file, so there's nothing to display here. Installed (installer-based) setups configure a log file automatically — a plain source build or container running without one is the only case that lands here."
          />
          <p className={styles.technicalNote}>Technical: LOOMBRE_LOG_FILE is not set on this instance.</p>
          <a href={ENV_REFERENCE_DOCS_URL} target="_blank" rel="noreferrer noopener" className={styles.notesLink}>
            Read how to enable a log file
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
