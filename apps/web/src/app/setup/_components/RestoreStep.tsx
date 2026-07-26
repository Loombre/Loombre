// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/setup/_components/RestoreStep.tsx
//
// Optional restore from a previously exported archive (docs/PLAN.md §8.4,
// STATE.md P4.10's wizard-restore seam — see apps/worker/src/import/
// consumer.ts's module header, and ../wizard-state.ts's module header for
// this lane's resolution of the step-ordering tension it creates).
//
// ExportArchive is the ENTIRE POST /import request body (no `mode` field
// is exposed over HTTP — the job payload's 'fail-if-not-empty' default
// cannot be overridden from here), so "upload an archive" means: read the
// selected .json file as text, JSON.parse it client-side, and send the
// parsed object as the SDK-typed request body. The SERVER (validateArchive
// in apps/worker/src/import/validate.ts, reached via the job) is the real
// validator — a malformed file surfaces as a 422 from POST /import or a
// 'failed' job with a lastError, never silently accepted.
//
// Job polling: GET /admin/jobs/{id} has no progress field (the consumer
// writes exactly one checkpoint row AFTER commit — see that module's
// header, "Transaction strategy" section) — this step polls status only
// (queued/active/completed/failed/cancelled) and shows an honest "working"
// state, never a fake percentage.

import { useEffect, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import { LoombreApiError, type components } from "@loombre/sdk";
import { Icon } from "../../../components/icon/Icon.js";
import { Button } from "../../../components/ui/Button.js";
import { BlazeSpinner } from "../../../components/ui/BlazeSpinner.js";
import { apiGet, apiPost } from "../../../lib/api-client.js";
import { deriveRestoreViewState, isTerminalJobStatus, type JobStatus, type WizardFlags } from "../wizard-state.js";
import styles from "./steps.module.css";

type ExportArchive = components["schemas"]["ExportArchive"];

const POLL_INTERVAL_MS = 1_500;

export interface RestoreStepProps {
  flags: WizardFlags;
  onNext: () => void;
}

export function RestoreStep({ flags, onNext }: RestoreStepProps): React.JSX.Element {
  const [job, setJob] = useState<{ status: JobStatus; lastError: string | null } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Mirrors `job.status` into a ref so the poll effect below can be keyed
  // on `jobId` ALONE (the poll target never changes mid-run) while still
  // being able to stop issuing new GETs once terminal, without tearing
  // down and restarting the interval on every status tick.
  const jobStatusRef = useRef<JobStatus | null>(null);
  useEffect(() => {
    jobStatusRef.current = job?.status ?? null;
  }, [job]);

  // Polls GET /admin/jobs/{id} once a restore has been enqueued.
  useEffect(() => {
    if (!jobId) return;
    const currentJobId: string = jobId; // narrowed once — closures below don't re-narrow across the function boundary
    let cancelled = false;

    async function poll(): Promise<void> {
      if (jobStatusRef.current && isTerminalJobStatus(jobStatusRef.current)) return;
      try {
        const current = await apiGet("/admin/jobs/{id}", { params: { path: { id: currentJobId } } });
        if (cancelled) return;
        setJob({ status: current.status, lastError: current.lastError });
      } catch {
        // Transient — the interval retries; nothing terminal to report yet.
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId]);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileError(null);
    setUploading(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("That file isn't valid JSON — export archives are a single .json file.");
      }
      const ref = await apiPost("/import", { body: parsed as ExportArchive });
      setJobId(ref.jobId);
      setJob({ status: "queued", lastError: null });
    } catch (err) {
      if (err instanceof LoombreApiError) {
        setFileError(err.message);
      } else if (err instanceof Error) {
        setFileError(err.message);
      } else {
        setFileError("Could not read or upload that file.");
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const view = deriveRestoreViewState(flags, job);

  return (
    <div className={styles.step}>
      <div className={styles.iconBadge} aria-hidden="true">
        <Icon icon={UploadCloud} />
      </div>
      <h2 className={styles.subtitle}>Restore from a backup</h2>

      {view === "blocked-library-created" && (
        <>
          <p className={styles.body}>
            Restore is only available while this instance is empty — you already created a
            library earlier in this wizard, so restoring an archive now would fail (the import
            job refuses to run against a non-empty instance, by design, to avoid silently
            merging into data you didn&apos;t ask to touch). Go to Admin → Data after finishing
            setup if you still want to restore, on a fresh instance.
          </p>
          <div className={styles.actionsEnd}>
            <Button type="button" variant="primary" onClick={onNext}>
              Continue
            </Button>
          </div>
        </>
      )}

      {view === "offer" && (
        <>
          <p className={styles.body}>
            If you have an export archive from a previous Loombre instance, restore it now while
            this instance is still empty. This step is entirely optional — skip it if you&apos;re
            starting fresh.
          </p>
          <div className={styles.dropzone}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={(e) => void handleFileChange(e)}
              disabled={uploading}
              aria-label="Export archive file"
            />
          </div>
          {fileError && <div className={styles.error}>{fileError}</div>}
          <div className={styles.actions}>
            <Button type="button" variant="ghost" onClick={onNext}>
              Skip restore
            </Button>
          </div>
        </>
      )}

      {view === "polling" && (
        <div className={styles.info}>
          <BlazeSpinner size={16} surface={`var(--color-surface)`} /> Restoring your archive… this can
          take a while for large libraries. This page will update automatically — status:{" "}
          {job?.status}.
        </div>
      )}

      {view === "succeeded" && (
        <>
          <div className={styles.success}>Restore completed successfully.</div>
          <div className={styles.actionsEnd}>
            <Button type="button" variant="primary" onClick={onNext}>
              Continue
            </Button>
          </div>
        </>
      )}

      {view === "failed" && (
        <>
          <div className={styles.error}>
            Restore failed{job?.lastError ? `: ${job.lastError}` : "."} You can try again from
            Admin → Data after finishing setup.
          </div>
          <div className={styles.actionsEnd}>
            <Button type="button" variant="primary" onClick={onNext}>
              Continue anyway
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
