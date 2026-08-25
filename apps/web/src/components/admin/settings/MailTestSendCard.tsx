// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/settings/MailTestSendCard.tsx
//
// M11/E6: "Send a test email" — POST /admin/mail/test-send enqueues a real
// mail-send job (never sends inline on this request thread) and returns
// {jobId}; this card subscribes the shared events socket for job.updated
// scoped to that jobId (the admin-dashboard-live.ts useLibraryScanState
// jobId-correlation pattern named in the task spec — "subscribeAll
// precedent in admin-dashboard-live.ts" — except this one filters a single
// event TYPE by jobId rather than wildcard-subscribing, since it only ever
// cares about ONE job's transitions) and renders the terminal result BOTH
// ways: delivered (status "completed") or failed (status "failed", with
// the REAL SMTP error text from errorMessage — never a generic "it
// failed"), plus a pending state for queued/active in between.
//
// 409 (mail not configured) is a DISTINCT outcome from a job failure — it
// means nothing was even enqueued. The explanation lists exactly which of
// the three prerequisites (mail.smtpHost, mail.fromAddress,
// network.publicUrl — M8's own "configured" definition) are unset, read
// from the AdminSettingsResponse this card is handed rather than a second
// fetch.

import { useEffect, useState } from "react";
import { Button } from "../../ui/Button.js";
import { TextInput } from "../../ui/Input.js";
import { StatusPill } from "../StatusPill.js";
import { describeJobStatus } from "../../../lib/admin-status.js";
import { apiPost, LoombreApiError } from "../../../lib/api-client.js";
import { getEventsSocket, type EventEnvelope } from "../../../lib/events-socket.js";
import type { components } from "@loombre/sdk";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./MailTestSendCard.module.css";

type AdminSettingsResponse = components["schemas"]["AdminSettingsResponse"];

/** packages/contract/event-schemas/job.updated.schema.json's relevant
 *  fields — this card only ever reads jobId/status/errorMessage. */
interface JobUpdatedPayload {
  jobId: string;
  status: "queued" | "active" | "completed" | "failed";
  errorMessage?: string | null;
}

interface Outcome {
  status: "queued" | "active" | "completed" | "failed";
  errorMessage: string | null;
}

function valueFor(settings: AdminSettingsResponse, key: string): unknown {
  return settings.settings.find((s) => s.key === key)?.value;
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** M8's own "configured" definition, applied to whichever of the three
 *  keys GET /admin/settings currently reports as unset — the 409 response
 *  itself carries no detail on WHICH prerequisite is missing, so this
 *  derives it client-side from data already on hand. */
function missingPrerequisites(settings: AdminSettingsResponse): string[] {
  const missing: string[] = [];
  if (isUnset(valueFor(settings, "mail.smtpHost"))) missing.push("SMTP host (mail.smtpHost)");
  if (isUnset(valueFor(settings, "mail.fromAddress"))) missing.push("from address (mail.fromAddress)");
  if (isUnset(valueFor(settings, "network.publicUrl"))) missing.push("public URL (network.publicUrl)");
  // Defensive fallback: the server rejected this as unconfigured, so SOME
  // reason exists even if this client-side re-derivation somehow finds
  // none (e.g. a settings snapshot that raced a concurrent admin edit).
  return missing.length > 0 ? missing : ["mail.smtpHost", "mail.fromAddress", "network.publicUrl"];
}

export function MailTestSendCard({ settings }: { settings: AdminSettingsResponse }): React.JSX.Element {
  const [to, setTo] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [unconfigured, setUnconfigured] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return undefined;
    const socket = getEventsSocket();
    return socket.subscribe<JobUpdatedPayload>("job.updated", (e: EventEnvelope<JobUpdatedPayload>) => {
      if (e.payload.jobId !== jobId) return;
      setOutcome({ status: e.payload.status, errorMessage: e.payload.errorMessage ?? null });
    });
  }, [jobId]);

  async function handleSend(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setUnconfigured(null);
    setOutcome(null);
    setJobId(null);
    try {
      const res = await apiPost("/admin/mail/test-send", { body: { to } });
      setJobId(res.jobId);
      setOutcome({ status: "queued", errorMessage: null });
    } catch (err) {
      if (err instanceof LoombreApiError && err.status === 409) {
        setUnconfigured(missingPrerequisites(settings));
      } else {
        setError(apiErrorCopy(err, "Failed to send test email."));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.title}>Send a test email</h2>
      </div>
      <p className={styles.helpText}>
        Runs the real delivery pipeline end to end and reports the outcome — a delivered message, or the exact SMTP
        error, never a simulated result.
      </p>
      <form className={styles.form} onSubmit={(e) => void handleSend(e)}>
        <TextInput
          type="email"
          placeholder="you@example.com"
          value={to}
          onChange={(ev) => setTo(ev.target.value)}
          autoComplete="off"
          required
        />
        <Button type="submit" variant="primary" disabled={submitting || to.trim().length === 0}>
          {submitting ? "Sending…" : "Send test"}
        </Button>
      </form>

      {unconfigured && (
        <div className={styles.unconfigured}>
          <p className={styles.unconfiguredTitle}>Mail isn&apos;t configured yet. Still needed:</p>
          <ul className={styles.unconfiguredList}>
            {unconfigured.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className={styles.errorText}>{error}</p>}

      {outcome && (
        <div className={styles.outcome}>
          <StatusPill label={describeJobStatus(outcome.status).label} tone={describeJobStatus(outcome.status).tone} />
          {outcome.status === "completed" && <span className={styles.outcomeText}>Delivered.</span>}
          {outcome.status === "failed" && (
            <span className={styles.outcomeText}>{outcome.errorMessage ?? "Delivery failed."}</span>
          )}
          {(outcome.status === "queued" || outcome.status === "active") && (
            <span className={styles.outcomeText}>Waiting for the send to complete…</span>
          )}
        </div>
      )}
    </section>
  );
}
