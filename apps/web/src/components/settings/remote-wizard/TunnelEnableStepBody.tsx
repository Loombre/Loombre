// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/TunnelEnableStepBody.tsx
//
// STATE.md "Loombre Remote ..." (R4, Lane U2's mission item 3) — the
// Tunnel path's "tunnel-enable" step (packages/shared's frozen
// PATH_FLOW_STEPS.tunnel[1]). Hostname entry -> POST
// /admin/remote/tunnel/enable -> live connector-health surfacing via
// polled GET /admin/remote/tunnel/status, HardwareStep.tsx's own
// setInterval-poll pattern (apps/web/src/app/setup/_components/
// HardwareStep.tsx: poll on mount, `setInterval`, cleanup clears it).
//
// Continue is available as soon as enable's own 200 response lands (the
// call is synchronous proof the tunnel + DNS route were created and the
// connector process was started) — polling continues to SHOW the
// connector settling from "starting" toward "running" (or surfacing
// "degraded"/"error" + lastErrorMessage honestly), but this step never
// BLOCKS progress on that transition finishing: the wizard's own R6 proof
// stage is what actually verifies end-to-end reachability next.

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { apiGet, apiPost } from "../../../lib/api-client.js";
import { apiErrorMessage } from "../../../lib/api-error-message.js";
import type { PathFlowStepBodyProps } from "./path-flow-step-types.js";
import styles from "./TunnelEnableStepBody.module.css";

type RemoteTunnelStatus = components["schemas"]["RemoteTunnelStatus"];

const POLL_INTERVAL_MS = 3_000;

const CONNECTOR_LABELS: Record<RemoteTunnelStatus["connectorState"], string> = {
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  degraded: "Degraded",
  error: "Error",
};

export function TunnelEnableStepBody({ onStepComplete, onBack }: PathFlowStepBodyProps): React.JSX.Element {
  const [hostname, setHostname] = useState("");
  const [status, setStatus] = useState<RemoteTunnelStatus | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll connector health only once enabled — before that, GET status
  // would just report the pre-enable stopped state on a loop for nothing.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const res = await apiGet("/admin/remote/tunnel/status");
        if (!cancelled) setStatus(res);
      } catch {
        // Transient poll failures are not surfaced as step-level errors —
        // the enable call itself already succeeded; this is a status
        // refresh, not a new mutation.
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  async function handleEnable(): Promise<void> {
    if (hostname.trim().length === 0) {
      setError("Enter the public hostname this tunnel should route.");
      return;
    }
    setEnabling(true);
    setError(null);
    try {
      const res = await apiPost("/admin/remote/tunnel/enable", { body: { hostname: hostname.trim() } });
      setStatus(res);
      setEnabled(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to enable the tunnel."));
    } finally {
      setEnabling(false);
    }
  }

  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Enable the Tunnel</p>

      {!enabled ? (
        <>
          <p className={styles.body}>
            Choose the public hostname that will route through this tunnel — Loombre creates the tunnel and its DNS
            route for you.
          </p>
          <TextInput
            placeholder="e.g. loombre.example.com"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            autoComplete="off"
            disabled={enabling}
          />
          {error && <p className={styles.errorText}>{error}</p>}
        </>
      ) : (
        <div className={styles.healthCard} role="status">
          <div className={styles.healthRow}>
            <span className={styles.connectorPill} data-state={status?.connectorState ?? "starting"}>
              {CONNECTOR_LABELS[status?.connectorState ?? "starting"]}
            </span>
            <span className={styles.hostname}>{status?.hostname ?? hostname}</span>
          </div>
          {status?.backoffMs !== null && status?.backoffMs !== undefined && (
            <p className={styles.detail}>Retrying in {Math.round(status.backoffMs / 1000)}s…</p>
          )}
          {status?.lastErrorMessage && <p className={styles.errorText}>{status.lastErrorMessage}</p>}
        </div>
      )}

      <div className={styles.stepActions}>
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack} disabled={enabling}>
            Back
          </Button>
        )}
        {!enabled ? (
          <Button type="button" variant="primary" onClick={() => void handleEnable()} disabled={enabling}>
            {enabling ? "Enabling…" : "Enable the tunnel"}
          </Button>
        ) : (
          <Button type="button" variant="primary" onClick={() => onStepComplete()}>
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}
