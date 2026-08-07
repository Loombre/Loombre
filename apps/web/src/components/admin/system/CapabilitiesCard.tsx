// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/system/CapabilitiesCard.tsx
//
// D-5 (Wave 2, this run — IA restructure): extracted verbatim from the
// deleted app/admin/system/page.tsx, now composed on the merged Dashboard
// (app/admin/page.tsx) instead. LOGIC UNCHANGED — this is a pure move, per
// the work item's explicit instruction to carry W1's three-state probe
// status intact, not rewrite it. See W1's own commit (D-1) for the full
// rationale on the never-ran/pending/failed/completed state machine below.

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { Card } from "../../ui/Card.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { EmptyState } from "../EmptyState.js";
import { formatFfmpegHashPrefix, formatProbeAge } from "../../../lib/admin-capability-format.js";
import { NO_ACCELERATION_COPY, hasNoAcceleratedCapabilities } from "../../../lib/capability-view.js";
import { formatOsLabel } from "../../../lib/os-label.js";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import styles from "./system-cards.module.css";
import { FolderOpen } from "lucide-react";

type CapabilityReport = components["schemas"]["CapabilityReport"];
type CapabilityProbeStatus = components["schemas"]["CapabilityProbeStatus"];

/** W1/D-1 (2026-08-07): the three no-report probe states render distinct,
 *  plain-language copy (never-ran / pending / failed), and a completed
 *  report that verified zero capabilities is presented as the valid
 *  "software everything" state — common in VMs and GPU-less servers —
 *  never as an unexplained empty table. */
export function CapabilitiesCard(): React.JSX.Element {
  const [envelope, setEnvelope] = useState<
    { report: CapabilityReport | null; probe?: CapabilityProbeStatus } | undefined
  >(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/admin/capabilities")
      .then((res) => setEnvelope(res))
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load capabilities."));
  }, []);

  const report = envelope?.report ?? null;
  const probeStatus = envelope?.probe?.status ?? "never-ran";
  const softwareOnly = report !== null && hasNoAcceleratedCapabilities(report);

  return (
    <Card>
      <h2 className={styles.cardTitle}>Verified hardware capabilities</h2>
      {error && <p className={styles.errorText}>{error}</p>}
      {envelope === undefined ? (
        <Skeleton radius="md" height={120} />
      ) : report === null ? (
        probeStatus === "failed" ? (
          <EmptyState
            icon={FolderOpen}
            title="Hardware check failed"
            body={`The last hardware self-test couldn't finish, so this server uses software for video decoding, encoding, and HDR conversion. Everything still works — software processing runs on any machine, it just uses more CPU during transcoding. The check runs again automatically the next time the worker starts.${envelope.probe?.lastError ? ` Details: ${envelope.probe.lastError}` : ""}`}
          />
        ) : probeStatus === "pending" ? (
          <EmptyState
            icon={FolderOpen}
            title="Hardware check in progress"
            body="The worker is running its hardware self-test now — results appear here the moment it finishes."
          />
        ) : (
          <EmptyState
            icon={FolderOpen}
            title="Hardware check hasn't run yet"
            body="The worker checks this machine's video hardware automatically at first boot (and after driver or ffmpeg changes). Nothing has been checked yet on this server."
          />
        )
      ) : (
        <>
          {probeStatus === "pending" && (
            <p className={styles.helpText}>
              A new hardware check is running now — the results below update when it finishes.
            </p>
          )}
          {probeStatus === "failed" && (
            <p className={styles.helpText}>
              The most recent hardware re-check failed; showing the last successful results.
              {envelope?.probe?.lastError ? ` Details: ${envelope.probe.lastError}` : ""}
            </p>
          )}
          {softwareOnly && <p className={styles.helpText}>{NO_ACCELERATION_COPY}</p>}
          <dl className={styles.factGrid}>
            <dt>Platform</dt>
            <dd>{formatOsLabel(report.platform)}</dd>
            <dt>ffmpeg build</dt>
            <dd title={report.ffmpegBuildHash} className={styles.mono}>
              {formatFfmpegHashPrefix(report.ffmpegBuildHash)}
            </dd>
            <dt>GPU</dt>
            <dd>{report.gpuFingerprint ?? "unknown (best-effort probe failed)"}</dd>
            <dt>Probed</dt>
            <dd>{formatProbeAge(report.verifiedAtMs, Date.now())}</dd>
          </dl>
          {report.backends.length > 0 && (
          <div className={styles.matrixWrap}>
            <table className={styles.matrix}>
              <thead>
                <tr>
                  <th>Backend</th>
                  <th>Decode</th>
                  <th>Encode</th>
                  <th>Tone-map</th>
                </tr>
              </thead>
              <tbody>
                {report.backends.map((backend) => (
                  <tr key={backend.position}>
                    <td className={styles.backendName}>{backend.name}</td>
                    <td>{backend.decode.length > 0 ? backend.decode.join(", ") : "—"}</td>
                    <td>{backend.encode.length > 0 ? backend.encode.join(", ") : "—"}</td>
                    <td>{backend.toneMap.length > 0 ? backend.toneMap.join(", ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </>
      )}
    </Card>
  );
}
