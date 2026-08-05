// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/ConnectorHealthPanel.tsx
//
// STATE.md "Loombre Remote ..." mission item 2 (lane U3): the Tunnel path's
// connector health panel — mounted inside PathManagementCard.tsx's Tunnel-
// specific section (extending that card, not rebuilding it; RemoteAccessSection
// owns overall layout). Two independent pieces:
//
//   1. Connector state: GET /admin/remote/tunnel/status (T1, real — the
//      supervised cloudflared child's lifecycle, RG7). Self-refreshing —
//      its own poll + a tunnel.connector.state socket subscription — on
//      purpose: PathManagementCard's `state` prop (RemoteState, fetched
//      once by RemoteAccessSection and only refetched after an explicit
//      user action) is not live; this panel's whole job is a live read of
//      the same RemoteTunnelStatus shape, so it fetches its own copy
//      rather than trusting the parent's possibly-stale one.
//   2. Log tail: GET /admin/remote/tunnel/logs (T1, real — the connector's
//      bounded in-memory stderr ring buffer, RG7). Fetched once on mount
//      for a non-blank first view, then MANUAL REFRESH ONLY per the
//      mission brief ("no streaming in v1") — no poll, no socket
//      subscription for this half.
//
// Honest-empty-state posture: an empty `lines` array (the Noop connector
// interface's default, or a real connector that simply hasn't logged
// anything yet) renders as "No log output yet", never a blank box that
// could read as broken.
//
// backoffMs/lastErrorMessage/connectorState are the ONLY connector-timing
// fields RemoteTunnelStatus actually carries (packages/contract/
// openapi.yaml) — restartCount and a `since` timestamp are NOT part of the
// frozen contract shape, so they are not rendered here (flagged in this
// lane's report rather than fabricated).

import { useCallback, useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { StatusPill } from "../../admin/StatusPill.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import type { PillTone } from "../../../lib/admin-status.js";
import { apiGet } from "../../../lib/api-client.js";
import { apiErrorMessage } from "../../../lib/api-error-message.js";
import { getEventsSocket } from "../../../lib/events-socket.js";
import styles from "./ConnectorHealthPanel.module.css";

type RemoteTunnelStatus = components["schemas"]["RemoteTunnelStatus"];
type ConnectorState = RemoteTunnelStatus["connectorState"];

/** Same "modest poll fallback while mounted" posture as PostureCard.tsx —
 *  the socket subscription is the primary freshness signal. */
const POLL_INTERVAL_MS = 30_000;

const STATE_INFO: Record<ConnectorState, { label: string; tone: PillTone }> = {
  stopped: { label: "Stopped", tone: "neutral" },
  starting: { label: "Starting", tone: "info" },
  running: { label: "Running", tone: "success" },
  degraded: { label: "Degraded", tone: "warning" },
  error: { label: "Error", tone: "danger" },
};

function formatBackoff(backoffMs: number): string {
  const seconds = Math.max(1, Math.round(backoffMs / 1000));
  return `retrying in ~${seconds}s…`;
}

export function ConnectorHealthPanel(): React.JSX.Element {
  const [status, setStatus] = useState<RemoteTunnelStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [logs, setLogs] = useState<readonly string[] | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  const refetchStatus = useCallback(() => {
    apiGet("/admin/remote/tunnel/status")
      .then((res) => {
        setStatus(res);
        setStatusError(null);
      })
      .catch((err: unknown) => {
        setStatusError(apiErrorMessage(err, "Failed to load connector status."));
      });
  }, []);

  const refetchLogs = useCallback(() => {
    setLogsLoading(true);
    apiGet("/admin/remote/tunnel/logs")
      .then((res) => {
        setLogs(res.lines);
        setLogsError(null);
      })
      .catch((err: unknown) => {
        setLogsError(apiErrorMessage(err, "Failed to load connector logs."));
      })
      .finally(() => setLogsLoading(false));
  }, []);

  useEffect(() => {
    refetchStatus();
    const timer = setInterval(refetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refetchStatus]);

  // Mount-only fetch, deliberately not repeated: the mission brief is
  // explicit ("no streaming in v1") — logs are a one-time initial pull
  // plus the manual "Refresh" button only, never auto-refreshed.
  // refetchLogs is stable (useCallback, empty deps) so listing it here
  // does not change that — it only satisfies the effect's own honesty
  // about what it reads.
  useEffect(() => {
    refetchLogs();
  }, [refetchLogs]);

  useEffect(() => {
    const socket = getEventsSocket();
    return socket.subscribe("tunnel.connector.state", () => refetchStatus());
  }, [refetchStatus]);

  return (
    <div className={styles.panel} data-testid="connector-health-panel">
      <p className={styles.label}>Tunnel connector</p>

      {statusError && <p className={styles.errorText}>{statusError}</p>}
      {!status && !statusError && <Skeleton radius="md" height={72} />}

      {status && (
        <>
          <div className={styles.stateRow}>
            <StatusPill label={STATE_INFO[status.connectorState].label} tone={STATE_INFO[status.connectorState].tone} />
            {status.backoffMs !== null && <span className={styles.backoff}>{formatBackoff(status.backoffMs)}</span>}
          </div>
          {status.lastErrorMessage && (
            <p className={styles.lastError}>
              <span className={styles.lastErrorLabel}>Last error</span> {status.lastErrorMessage}
            </p>
          )}
        </>
      )}

      <div className={styles.logsSection}>
        <div className={styles.logsHeader}>
          <span className={styles.logsLabel}>Connector logs</span>
          <Button type="button" variant="secondary" onClick={refetchLogs} disabled={logsLoading}>
            {logsLoading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        {logsError && <p className={styles.errorText}>{logsError}</p>}
        {logs === null && !logsError ? (
          <Skeleton radius="sm" height={96} />
        ) : logs && logs.length === 0 ? (
          <p className={styles.logsEmpty}>No log output yet.</p>
        ) : (
          logs && (
            <pre className={styles.logsTail} role="log" aria-label="Connector log tail">
              {logs.join("\n")}
            </pre>
          )
        )}
      </div>
    </div>
  );
}
