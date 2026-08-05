// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/PathManagementCard.tsx
//
// RemoteAccessSection's "active path" view (mission item 1): path name,
// per-path status summary, Switch path / Disable, the posture-card seam,
// and a devices-list link for the Remote path. Mission item 4: switch/
// disable both call the REAL disable* endpoint (still 501 on this lane's
// base — see the LoombreApiError 501 branch below) and show a teardown
// checklist driven by the frozen DISABLE_VERIFICATION_STEPS.
//
// Switch reuses disable's exact mechanics (R8: "switch = verified teardown
// then enable") — the confirm wording differs, and on success SWITCH calls
// onSwitchPath (parent reopens the wizard fresh) instead of settling into
// an idle "disabled" state. Because the endpoint's own contract says
// disable is atomic and verified server-side ("revokes every enrolled peer
// and drops the listener, verified — not merely a flag flip"), a 200
// response means every listed verification step is true — this renders
// them as done TOGETHER rather than staging a fake per-step progress
// animation the API cannot actually back up (the honesty rule mission item
// 4 calls out explicitly).
//
// U3 extensions (STATE.md "Loombre Remote ..." mission items 2 + 3):
// ConnectorHealthPanel mounts here for the Tunnel path (self-contained,
// live) and RemoteDevicesPanel mounts here for the Remote path (additive
// to the existing self-service devices link above it) — both extend this
// card's per-path section rather than living in a separate surface,
// keeping U1's single "active path" view intact.

import { useState } from "react";
import Link from "next/link";
import type { components } from "@loombre/sdk";
import { DISABLE_VERIFICATION_STEPS, type DisableVerificationStep, type PathId } from "@loombre/shared/remote";
import { Card } from "../../ui/Card.js";
import { Button } from "../../ui/Button.js";
import { StatusPill } from "../../admin/StatusPill.js";
import { apiPost, LoombreApiError } from "../../../lib/api-client.js";
import { PostureCardSlot } from "./PostureCardSlot.js";
import { ConnectorHealthPanel } from "./ConnectorHealthPanel.js";
import { RemoteDevicesPanel } from "./RemoteDevicesPanel.js";
import { PATH_LABELS } from "./path-labels.js";
import styles from "./PathManagementCard.module.css";

type RemoteState = components["schemas"]["RemoteState"];

const DISABLE_STEP_LABELS: Record<DisableVerificationStep, string> = {
  "revoke-peers": "Revoke every enrolled device key",
  "drop-listeners": "Stop listening for connections",
  "teardown-connector": "Stop the tunnel connector",
};

const DISABLE_SUMMARY: Record<PathId, string> = {
  remote: "Every enrolled device is revoked and the listener stops.",
  tunnel: "The tunnel and DNS route are torn down and the connector stops.",
  direct: "The public listener stops accepting connections.",
};

async function callDisable(path: PathId): Promise<unknown> {
  switch (path) {
    case "remote":
      return apiPost("/admin/remote/wireguard/disable", {});
    case "tunnel":
      return apiPost("/admin/remote/tunnel/disable", {});
    case "direct":
      return apiPost("/admin/remote/direct/disable", {});
  }
}

type Phase = "idle" | "confirmDisable" | "confirmSwitch" | "tearingDown" | "disabled" | "unavailable";

export function PathManagementCard({
  state,
  onSwitchPath,
  onChanged,
}: {
  state: RemoteState;
  /** Old path has been verified torn down — parent should now open the
   *  wizard fresh so the admin can pick and configure a new one. */
  onSwitchPath: () => void;
  /** Server state changed (disable succeeded) — parent should refetch
   *  GET /admin/remote/state. */
  onChanged: () => void;
}): React.JSX.Element | null {
  const activePath = state.activePath;
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [completedSteps, setCompletedSteps] = useState<ReadonlySet<DisableVerificationStep>>(new Set());

  if (activePath === "none") return null;
  // Reassigned with an explicit PathId type (rather than relying on
  // control-flow narrowing of `activePath` itself) so the nested
  // `handleTeardown` function DECLARATION below — hoisted, so TS does not
  // carry the guard's narrowing into it — still sees the excluded-'none'
  // type instead of widening back to the full RemotePathId union.
  const path: PathId = activePath;

  const steps = DISABLE_VERIFICATION_STEPS[path];

  async function handleTeardown(intent: "disable" | "switch"): Promise<void> {
    setPhase("tearingDown");
    setError(null);
    setCompletedSteps(new Set());
    try {
      await callDisable(path);
      setCompletedSteps(new Set(steps));
      onChanged();
      if (intent === "switch") {
        onSwitchPath();
      } else {
        setPhase("disabled");
      }
    } catch (err) {
      if (err instanceof LoombreApiError && err.status === 501) {
        setPhase("unavailable");
        return;
      }
      setError(err instanceof LoombreApiError ? err.message : `Failed to disable ${PATH_LABELS[path]}.`);
      setPhase("idle");
    }
  }

  return (
    <Card>
      <div className={styles.headerRow}>
        <span className={styles.pathLabel}>{PATH_LABELS[path]}</span>
        <StatusPill label="Active" tone="success" />
      </div>

      <dl className={styles.statusList}>
        {path === "remote" && (
          <>
            <div className={styles.statusRow}>
              <dt>Listener</dt>
              <dd>{state.wireguard.listening ? "Listening" : "Not listening"} · port {state.wireguard.listenPort}</dd>
            </div>
            <div className={styles.statusRow}>
              <dt>Enrolled devices</dt>
              <dd>{state.wireguard.peerCount}</dd>
            </div>
            <div className={styles.statusRow}>
              <dt>Subnet</dt>
              <dd>{state.wireguard.subnet}</dd>
            </div>
          </>
        )}
        {path === "tunnel" && (
          <>
            <div className={styles.statusRow}>
              <dt>Connector</dt>
              <dd>{state.tunnel.connectorState}</dd>
            </div>
            <div className={styles.statusRow}>
              <dt>Hostname</dt>
              <dd>{state.tunnel.hostname ?? "Not set"}</dd>
            </div>
            {state.tunnel.lastErrorMessage && (
              <div className={styles.statusRow}>
                <dt>Last error</dt>
                <dd>{state.tunnel.lastErrorMessage}</dd>
              </div>
            )}
          </>
        )}
        {path === "direct" && (
          <>
            <div className={styles.statusRow}>
              <dt>Mode</dt>
              <dd>{state.direct.mode ?? "Not set"}</dd>
            </div>
            <div className={styles.statusRow}>
              <dt>Domain</dt>
              <dd>{state.direct.domain ?? "Not set"}</dd>
            </div>
            <div className={styles.statusRow}>
              <dt>Certificate</dt>
              <dd>{state.direct.certValid === null ? "Unknown" : state.direct.certValid ? "Valid" : "Invalid"}</dd>
            </div>
          </>
        )}
      </dl>

      {path === "remote" && (
        <>
          <Link href="/settings/devices" className={styles.devicesLink}>
            Manage enrolled devices →
          </Link>
          <RemoteDevicesPanel />
        </>
      )}

      {path === "tunnel" && <ConnectorHealthPanel />}

      <PostureCardSlot activePath={path} />

      {error && <p className={styles.errorText}>{error}</p>}

      {phase === "idle" && (
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={() => setPhase("confirmSwitch")}>
            Switch path…
          </Button>
          <Button type="button" variant="danger" onClick={() => setPhase("confirmDisable")}>
            Disable…
          </Button>
        </div>
      )}

      {phase === "confirmDisable" && (
        <div className={styles.confirmBlock}>
          <span className={styles.confirmText}>
            Disable {PATH_LABELS[path]}? {DISABLE_SUMMARY[path]} You can re-enable it later, but everything will need
            to be set up again.
          </span>
          <div className={styles.confirmActions}>
            <Button type="button" variant="danger" onClick={() => void handleTeardown("disable")}>
              Disable {PATH_LABELS[path]}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPhase("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {phase === "confirmSwitch" && (
        <div className={styles.confirmBlock}>
          <span className={styles.confirmText}>
            Switch away from {PATH_LABELS[path]}? {DISABLE_SUMMARY[path]} You'll pick and set up a different path
            right after.
          </span>
          <div className={styles.confirmActions}>
            <Button type="button" variant="danger" onClick={() => void handleTeardown("switch")}>
              Disable and switch
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPhase("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {phase === "tearingDown" && (
        <ul className={styles.teardownList} role="status" aria-label="Verifying teardown">
          {steps.map((s) => (
            <li key={s} data-done={completedSteps.has(s)}>
              {DISABLE_STEP_LABELS[s]}
            </li>
          ))}
        </ul>
      )}

      {phase === "disabled" && (
        <div className={styles.teardownDone} role="status">
          <ul className={styles.teardownList}>
            {steps.map((s) => (
              <li key={s} data-done="true">
                {DISABLE_STEP_LABELS[s]} — verified
              </li>
            ))}
          </ul>
          <Button type="button" variant="secondary" onClick={() => setPhase("idle")}>
            OK
          </Button>
        </div>
      )}

      {phase === "unavailable" && (
        <div className={styles.teardownDone} role="status">
          <p className={styles.errorText}>Disabling {PATH_LABELS[path]} isn't available in this build yet.</p>
          <Button type="button" variant="secondary" onClick={() => setPhase("idle")}>
            OK
          </Button>
        </div>
      )}
    </Card>
  );
}
