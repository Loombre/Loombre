// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/setup/_components/HardwareStep.tsx
//
// Polls GET /admin/capabilities (admin token from AdminStep) and renders
// the CapabilityReport's backends/decode/encode/toneMap. `report` is null
// until the worker's first 'hwprobe' job completes (contract's
// CapabilityReportEnvelope doc comment) — an honest empty state explains
// that rather than showing a fake spinner-forever with no context, and
// polling continues indefinitely so the step self-updates the moment the
// worker catches up. Progressing past this step never blocks on the probe
// completing — a worker that hasn't started yet is not this wizard's job
// to fix, and the admin capability report is always viewable later from
// Admin → System anyway.

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Icon } from "../../../components/icon/Icon.js";
import { Button } from "../../../components/ui/Button.js";
import { Chip } from "../../../components/ui/Chip.js";
import { BlazeSpinner } from "../../../components/ui/BlazeSpinner.js";
import { apiGet } from "../../../lib/api-client.js";
import { deriveHardwareViewState } from "../wizard-state.js";
import styles from "./steps.module.css";

type CapabilityReport = components["schemas"]["CapabilityReport"];

const POLL_INTERVAL_MS = 4_000;

export interface HardwareStepProps {
  onNext: () => void;
}

export function HardwareStep({ onNext }: HardwareStepProps): React.JSX.Element {
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [pollError, setPollError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const envelope = await apiGet("/admin/capabilities");
        if (cancelled) return;
        setReport(envelope.report);
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

  const view = deriveHardwareViewState(report);

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

      {view === "empty" ? (
        <div className={styles.info}>
          <BlazeSpinner size={16} surface={`var(--color-surface)`} /> Worker not detected yet — the
          probe runs automatically when the worker starts. This page keeps checking every few
          seconds; you don&apos;t need to wait here, the report is always available later from
          Admin → System.
        </div>
      ) : (
        <div className={styles.reportGrid}>
          <p className={styles.body}>
            Platform: <strong>{report!.platform}</strong> — verified{" "}
            {new Date(report!.verifiedAtMs).toLocaleString()}
          </p>
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
