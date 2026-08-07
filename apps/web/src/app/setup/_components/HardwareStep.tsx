// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/setup/_components/HardwareStep.tsx
//
// Polls GET /admin/capabilities (admin token from AdminStep) and renders
// the CapabilityReport's backends/decode/encode/toneMap. W1/D-1
// (2026-08-07): the envelope's `probe` status drives THREE distinct
// no-report states — never-ran, pending (self-test queued/running), and
// failed (the self-test errored; software is used for everything) — the
// old copy mislabeled all of them "Worker not detected yet", a worker
// fact this component has no source for. A completed report with zero
// verified capabilities is rendered as the valid "software everything"
// state, not an error. Polling continues indefinitely so the step
// self-updates the moment the worker catches up. Progressing past this
// step never blocks on the probe — the report is always viewable later
// from Admin → System anyway.

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Icon } from "../../../components/icon/Icon.js";
import { Button } from "../../../components/ui/Button.js";
import { Chip } from "../../../components/ui/Chip.js";
import { BlazeSpinner } from "../../../components/ui/BlazeSpinner.js";
import { apiGet } from "../../../lib/api-client.js";
import { NO_ACCELERATION_COPY, hasNoAcceleratedCapabilities } from "../../../lib/capability-view.js";
import { deriveHardwareViewState } from "../wizard-state.js";
import styles from "./steps.module.css";

type CapabilityReport = components["schemas"]["CapabilityReport"];
type CapabilityProbeStatus = components["schemas"]["CapabilityProbeStatus"];

const POLL_INTERVAL_MS = 4_000;

export interface HardwareStepProps {
  onNext: () => void;
}

export function HardwareStep({ onNext }: HardwareStepProps): React.JSX.Element {
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [probe, setProbe] = useState<CapabilityProbeStatus | null>(null);
  const [pollError, setPollError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const envelope = await apiGet("/admin/capabilities");
        if (cancelled) return;
        setReport(envelope.report);
        setProbe(envelope.probe ?? null);
        setPollError(false);
      } catch {
        if (!cancelled) setPollError(true);
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const view = deriveHardwareViewState(report, probe);
  const softwareOnly = report !== null && hasNoAcceleratedCapabilities(report);

  return (
    <div className={styles.step}>
      <div className={styles.iconBadge} aria-hidden="true">
        <Icon icon={Cpu} />
      </div>
      <h2 className={styles.subtitle}>Hardware capabilities</h2>
      <p className={styles.body}>
        Loombre probes this machine&apos;s hardware video decode/encode/tone-mapping support so
        playback picks the fastest available path. This happens automatically once the worker
        process starts — nothing to configure here.
      </p>

      {view === "never-ran" && (
        <div className={styles.info}>
          <BlazeSpinner size={16} surface={`var(--color-surface)`} /> The hardware check hasn&apos;t
          run yet — it starts automatically once the background worker is up. This page keeps
          checking every few seconds; you don&apos;t need to wait here, the results are always
          available later from Admin → System.
        </div>
      )}
      {view === "pending" && (
        <div className={styles.info}>
          <BlazeSpinner size={16} surface={`var(--color-surface)`} /> The hardware check is running
          now — results appear here the moment it finishes. You don&apos;t need to wait; you can
          continue and review them later from Admin → System.
        </div>
      )}
      {view === "failed" && (
        <div className={styles.info}>
          The hardware check couldn&apos;t finish, so Loombre will process video in software instead.
          Everything still works — software processing runs on any machine, it just uses more CPU
          during transcoding. The check runs again automatically the next time the worker starts.
          {probe?.lastError ? <span className={styles.hint}> Details: {probe.lastError}</span> : null}
        </div>
      )}
      {view === "ready" && (
        <div className={styles.reportGrid}>
          <p className={styles.body}>
            Platform: <strong>{report!.platform}</strong> — verified{" "}
            {new Date(report!.verifiedAtMs).toLocaleString()}
          </p>
          {softwareOnly && <p className={styles.body}>{NO_ACCELERATION_COPY}</p>}
          {report!.backends.map((backend) => (
            <div className={styles.backendCard} key={backend.name}>
              <span className={styles.backendName}>{backend.name}</span>
              <div className={styles.backendChips}>
                {backend.decode.length > 0 && <Chip>decode: {backend.decode.join(", ")}</Chip>}
                {backend.encode.length > 0 && <Chip>encode: {backend.encode.join(", ")}</Chip>}
                {backend.toneMap.length > 0 && <Chip>tone-map: {backend.toneMap.join(", ")}</Chip>}
                {backend.decode.length === 0 && backend.encode.length === 0 && backend.toneMap.length === 0 && (
                  <Chip>no accelerated paths</Chip>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {pollError && <div className={styles.error}>Could not reach the server for a capability check — retrying automatically.</div>}

      <div className={styles.actionsEnd}>
        <Button type="button" variant="primary" onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}
