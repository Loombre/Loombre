// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/DirectEnableStepBody.tsx
//
// STATE.md "Loombre Remote ..." (R5, Lane U2's mission item 4) — the
// Direct path's "direct-enable" step (packages/shared's frozen
// PATH_FLOW_STEPS.direct[2]), reached by BOTH of Direct's branches:
//   - mode: acme — DirectAcmeTestStepBody.tsx already called
//     enableRemoteDirect itself (see that file's header for why: no
//     context field exists to carry the tested domain across the step
//     boundary). This branch is a CONFIRMATION read, not a new mutation —
//     GET /admin/remote/state shows what was just committed, then hands
//     off to the restart control.
//   - mode: reverse-proxy — nextPathFlowStep's documented skip means THIS
//     is the first step actually reached for this branch. Renders the
//     trust-proxy guidance (network.trustProxy's own settings-registry
//     description, restated here since this step is where it becomes
//     load-bearing) + a docs reference, then calls enableRemoteDirect
//     itself (mode: reverse-proxy, no domain).
//
// HONEST "restart needed" (apps/server/src/remote/remote-direct.controller.ts's
// own header: "this controller never calls ServerPowerService... GET
// /admin/settings' own restartPendingKeys is what tells the wizard UI a
// restart is owed" — this step doesn't poll that itself; it points
// plainly at the existing server-power UI (Settings -> Server,
// ServerPowerCard.tsx) rather than re-implementing restart-pending
// detection a second time).

import { useEffect, useState } from "react";
import Link from "next/link";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { apiGet, apiPost } from "../../../lib/api-client.js";
import { apiErrorMessage } from "../../../lib/api-error-message.js";
import type { PathFlowStepBodyProps } from "./path-flow-step-types.js";
import styles from "./DirectEnableStepBody.module.css";

type RemoteState = components["schemas"]["RemoteState"];

function AcmeConfirmBranch({ onStepComplete, onBack }: PathFlowStepBodyProps): React.JSX.Element {
  // The enable call already succeeded in DirectAcmeTestStepBody.tsx — this
  // read only ENRICHES the confirmation with domain/cert detail, it never
  // gates showing that Direct access is on. GET /admin/remote/state is
  // still a Wave-0 conforming-501 shell on this lane's actual base (no
  // lane has replaced it yet — verified against apps/server/src/remote/
  // remote-state.controller.ts), so a 501/any failure here degrades to a
  // quieter note, never a blocking error over a fact we already know.
  const [state, setState] = useState<RemoteState | null>(null);
  const [confirmUnavailable, setConfirmUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet("/admin/remote/state")
      .then((res) => {
        if (!cancelled) setState(res);
      })
      .catch(() => {
        if (!cancelled) setConfirmUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Enable Direct access</p>
      <p className={styles.successText} role="status">
        Direct access is enabled{state?.direct.domain ? ` for ${state.direct.domain}` : ""}.
        {state?.direct.certValid ? " The certificate is valid." : ""}
      </p>
      {confirmUnavailable && <p className={styles.unavailable}>Live confirmation details aren't available on this build yet.</p>}
      <div className={styles.restartCard}>
        <p className={styles.restartHeading}>A restart is needed to apply this</p>
        <p className={styles.body}>
          Loombre commits configuration changes immediately but only applies TLS mode changes on the next restart —
          restart from Settings whenever it's convenient.
        </p>
        <Link href="/settings/server" className={styles.link}>
          Go to Server settings →
        </Link>
      </div>
      <div className={styles.stepActions}>
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        <Button type="button" variant="primary" onClick={() => onStepComplete()}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function ReverseProxyBranch({ onStepComplete, onBack }: PathFlowStepBodyProps): React.JSX.Element {
  const [enabling, setEnabling] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEnable(): Promise<void> {
    setEnabling(true);
    setError(null);
    try {
      await apiPost("/admin/remote/direct/enable", { body: { mode: "reverse-proxy" } });
      setEnabled(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to enable Direct access."));
    } finally {
      setEnabling(false);
    }
  }

  if (enabled) {
    return (
      <div className={styles.step}>
        <p className={styles.stepTitle}>Enable Direct access</p>
        <p className={styles.successText} role="status">
          Direct access is enabled in reverse-proxy mode.
        </p>
        <div className={styles.restartCard}>
          <p className={styles.restartHeading}>A restart is needed to apply this</p>
          <p className={styles.body}>
            Loombre commits configuration changes immediately but only applies proxy-trust changes on the next
            restart — restart from Settings whenever it's convenient.
          </p>
          <Link href="/settings/server" className={styles.link}>
            Go to Server settings →
          </Link>
        </div>
        <div className={styles.stepActions}>
          <Button type="button" variant="primary" onClick={() => onStepComplete()}>
            Continue
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Enable Direct access</p>
      <p className={styles.body}>
        You said something else already terminates TLS in front of Loombre. Loombre needs to trust that proxy's
        forwarded-address headers to rate-limit and log correctly — set <code>network.trustProxy</code> from Settings
        → Advanced Server (a hop count, or the proxy's own address/range) before enabling here.
      </p>
      <p className={styles.body}>See docs/ops/reverse-proxy.md for full reverse-proxy configuration guidance.</p>
      {error && <p className={styles.errorText}>{error}</p>}
      <div className={styles.stepActions}>
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack} disabled={enabling}>
            Back
          </Button>
        )}
        <Button type="button" variant="primary" onClick={() => void handleEnable()} disabled={enabling}>
          {enabling ? "Enabling…" : "Enable Direct access"}
        </Button>
      </div>
    </div>
  );
}

export function DirectEnableStepBody(props: PathFlowStepBodyProps): React.JSX.Element {
  return props.context.directMode === "reverse-proxy" ? <ReverseProxyBranch {...props} /> : <AcmeConfirmBranch {...props} />;
}
