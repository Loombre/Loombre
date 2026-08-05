// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/DirectAcmeTestStepBody.tsx
//
// STATE.md "Loombre Remote ..." (R5/RG12, Lane U2's mission item 4) — the
// Direct path's "direct-acme-test" step (packages/shared's frozen
// PATH_FLOW_STEPS.direct[1]; only reached when context.directMode ===
// "acme" — DirectModeChoiceBody's own reverse-proxy branch SKIPS this step
// entirely via nextPathFlowStep, per PathFlowStepSlot.tsx's header).
//
// Domain entry -> POST /admin/remote/direct/acme-test (a REAL staged test
// issuance, apps/server/src/remote/remote-direct.controller.ts's own
// header: "leaves a real, valid, ready-to-serve certificate sitting
// exactly where the real ACME runtime will look for it... NEVER touches
// tls.mode") -> staged result with failureStage guidance
// (acme-failure-stage.ts, this lane's own classifier — the frozen
// RemoteDirectAcmeTestResult contract carries only {success, detail}).
//
// THE ENABLE CALL ALSO HAPPENS HERE (mission's own framing: "ACME step
// (domain entry, testRemoteDirectAcme ..., then enableRemoteDirect + the
// honest restart-needed handoff...)" describes the acme branch as ONE
// continuous flow) — deliberately, NOT split across into the
// "direct-enable" step: PathFlowContext (packages/shared's frozen
// wizard-state.ts) carries only `directMode`, no field for the domain a
// separately-mounted "direct-enable" step body would need (each step body
// is a fresh component instance — PathFlowStage.tsx swaps
// PATH_FLOW_STEP_BODIES[step], not the SAME component re-rendered — so
// nothing else survives the step boundary). Keeping domain entry, test,
// AND enable together avoids inventing an unreviewed extension to that
// frozen shape; DirectEnableStepBody.tsx's own acme branch reads back
// GET /admin/remote/state (the real source of truth) to show what was
// just enabled, rather than needing the domain passed to it at all.

import { useState } from "react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { apiPost } from "../../../lib/api-client.js";
import { apiErrorMessage } from "../../../lib/api-error-message.js";
import { ACME_FAILURE_STAGE_GUIDANCE, classifyAcmeFailureStage } from "./acme-failure-stage.js";
import type { PathFlowStepBodyProps } from "./path-flow-step-types.js";
import styles from "./DirectAcmeTestStepBody.module.css";

type RemoteDirectAcmeTestResult = components["schemas"]["RemoteDirectAcmeTestResult"];

type Phase = "form" | "testing" | "tested" | "enabling" | "enabled";

export function DirectAcmeTestStepBody({ onStepComplete, onBack }: PathFlowStepBodyProps): React.JSX.Element {
  const [domain, setDomain] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [result, setResult] = useState<RemoteDirectAcmeTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Editing the domain after a test invalidates that test — enabling MUST
   *  use the exact domain that was actually tested, never a stale
   *  success result attached to a domain that changed underneath it. */
  function handleDomainChange(next: string): void {
    setDomain(next);
    if (result !== null) {
      setResult(null);
      setPhase("form");
    }
  }

  async function handleTest(): Promise<void> {
    if (domain.trim().length === 0) {
      setError("Enter the domain this server will be reachable at.");
      return;
    }
    setPhase("testing");
    setError(null);
    setResult(null);
    try {
      const res = await apiPost("/admin/remote/direct/acme-test", { body: { domain: domain.trim() } });
      setResult(res);
      setPhase("tested");
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to run the staged test issuance."));
      setPhase("form");
    }
  }

  async function handleEnable(): Promise<void> {
    setPhase("enabling");
    setError(null);
    try {
      await apiPost("/admin/remote/direct/enable", { body: { mode: "acme", domain: domain.trim() } });
      setPhase("enabled");
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to enable Direct access."));
      setPhase("tested");
    }
  }

  const failureStage = result && !result.success ? classifyAcmeFailureStage(result.detail) : null;

  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Test certificate issuance</p>
      <p className={styles.body}>
        Loombre will request a real certificate for your domain from Let's Encrypt, using port 80 to prove you
        control it — this only ISSUES the certificate; it doesn't switch traffic over yet.
      </p>

      <TextInput
        placeholder="e.g. media.example.com"
        value={domain}
        onChange={(e) => handleDomainChange(e.target.value)}
        autoComplete="off"
        disabled={phase === "testing" || phase === "enabling" || phase === "enabled"}
      />

      {phase !== "form" && phase !== "testing" && result && (
        <div className={styles.resultCard} data-success={result.success} role="status">
          {result.success ? (
            <p className={styles.successText}>{result.detail}</p>
          ) : (
            <>
              <p className={styles.errorText}>{result.detail}</p>
              {failureStage && <p className={styles.guidance}>{ACME_FAILURE_STAGE_GUIDANCE[failureStage]}</p>}
            </>
          )}
        </div>
      )}

      {error && <p className={styles.errorText}>{error}</p>}

      {phase === "enabled" && (
        <p className={styles.successText} role="status">
          Direct access is enabled for {domain.trim()}. A restart is needed to apply it — the next step points you at
          the restart control.
        </p>
      )}

      <div className={styles.stepActions}>
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack} disabled={phase === "testing" || phase === "enabling"}>
            Back
          </Button>
        )}
        {phase !== "enabled" && result?.success !== true && (
          <Button type="button" variant="primary" onClick={() => void handleTest()} disabled={phase === "testing"}>
            {phase === "testing" ? "Testing…" : "Test certificate issuance"}
          </Button>
        )}
        {result?.success === true && phase !== "enabled" && (
          <Button type="button" variant="primary" onClick={() => void handleEnable()} disabled={phase === "enabling"}>
            {phase === "enabling" ? "Enabling…" : "Enable Direct access"}
          </Button>
        )}
        {phase === "enabled" && (
          <Button type="button" variant="primary" onClick={() => onStepComplete()}>
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}
