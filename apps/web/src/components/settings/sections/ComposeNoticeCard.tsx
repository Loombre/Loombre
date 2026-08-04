// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/ComposeNoticeCard.tsx
//
// Settings -> Notices, card (b): compose + publish a system notice
// (POST /system/notices, mission N4/N5). Durations stay RELATIVE end to
// end — the two duration selects resolve to `effectiveInMs`/`expiresInMs`
// integers computed from "now" at submit time; this file never builds an
// absolute timestamp (NG5 — the server alone anchors to its own clock).
//
// Client-side validation mirrors the server (contract's publishSystemNotice
// description) but the server stays authoritative — every error path here
// still lands on a 422 problem detail path too:
//   - message required, <= 500 chars (also hard-truncated as it's typed —
//     see handleMessageChange, which truncates the actual VALUE rather than
//     trusting `maxLength` alone: a test/consumer that sets `.value`
//     directly bypasses native maxLength enforcement, only a real slice()
//     in the change handler is deterministic).
//   - severity=warning REQUIRES an expiry choice.
//   - effective (when set) must not be after expiry (when set).
//
// Replace-confirm (N1): if a currently-active notice exists, Publish does
// NOT POST immediately — it stashes the validated request body and shows
// an explicit danger-tinted "Replace the current notice?" step naming the
// notice being replaced (ProviderKeysCard/InvitesPanel confirm-block
// recipe). With no active notice, Publish POSTs directly. A failed POST
// from EITHER path always returns to the plain form, actionable, with the
// problem detail shown (lying-Saved law / InvitesPanel regression class —
// never a stuck confirm/progress block).

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { Card } from "../../ui/Card.js";
import { Button } from "../../ui/Button.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { apiPost, LoombreApiError } from "../../../lib/api-client.js";
import { truncateMessage } from "./notice-display.js";
import sharedStyles from "./shared.module.css";
import styles from "./NoticesSection.module.css";

type NoticeSeverity = components["schemas"]["NoticeSeverity"];
type SystemNoticeAdmin = components["schemas"]["SystemNoticeAdmin"];
type PublishSystemNoticeRequest = components["schemas"]["PublishSystemNoticeRequest"];

const MESSAGE_MAX = 500;

type EffectiveChoice = "none" | "5" | "15" | "30" | "60" | "custom";
type ExpiryChoice = "" | "30m" | "1h" | "4h" | "24h" | "custom" | "untilCancelled";

const EFFECTIVE_MINUTES: Partial<Record<EffectiveChoice, number>> = { "5": 5, "15": 15, "30": 30, "60": 60 };
const EXPIRY_MINUTES: Partial<Record<ExpiryChoice, number>> = { "30m": 30, "1h": 60, "4h": 240, "24h": 1440 };

const SEVERITY_OPTIONS: { value: NoticeSeverity; label: string }[] = [
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "critical", label: "Critical" },
];

// A Record (not `.find()...label`) so this is typed as plain `string`, not
// `string | undefined` — SegmentedControlProps.defaultValue is optional
// under this repo's `exactOptionalPropertyTypes: true` (tsconfig), which
// rejects an explicit `undefined` even though `.find()` can never actually
// miss here (severity is always one of the three keys below).
const SEVERITY_LABEL: Record<NoticeSeverity, string> = { info: "Info", warning: "Warning", critical: "Critical" };

const MAINTENANCE_MESSAGE =
  "The server is undergoing scheduled maintenance. Some features may be temporarily unavailable.";

function restartMessage(minutes: number): string {
  return `The server will restart in about ${minutes} minutes. Playback may pause briefly — it will resume on its own.`;
}

interface PresetValues {
  severity: NoticeSeverity;
  effectiveChoice: EffectiveChoice;
  expiryChoice: ExpiryChoice;
  expiryCustomMinutes: string;
  message: string;
}

// N4's exact three restart presets: "restart in N minutes" (critical,
// effectiveInMs = N min) with expiresInMs = N + 10 minutes so the notice
// self-clears shortly after the restart window closes.
const RESTART_PRESETS: Record<"restart5" | "restart15" | "restart30", PresetValues> = {
  restart5: { severity: "critical", effectiveChoice: "5", expiryChoice: "custom", expiryCustomMinutes: "15", message: restartMessage(5) },
  restart15: { severity: "critical", effectiveChoice: "15", expiryChoice: "custom", expiryCustomMinutes: "25", message: restartMessage(15) },
  restart30: { severity: "critical", effectiveChoice: "30", expiryChoice: "custom", expiryCustomMinutes: "40", message: restartMessage(30) },
};

const MAINTENANCE_PRESET: PresetValues = {
  severity: "warning",
  effectiveChoice: "none",
  expiryChoice: "", // expiry mandatory for warning — deliberately left for the admin to choose
  expiryCustomMinutes: "",
  message: MAINTENANCE_MESSAGE,
};

const CUSTOM_PRESET: PresetValues = {
  severity: "info",
  effectiveChoice: "none",
  expiryChoice: "",
  expiryCustomMinutes: "",
  message: "",
};

interface FormErrors {
  message?: string;
  effective?: string;
  expiry?: string;
  cross?: string;
}

function parseMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 ? n : null;
}

type Resolved = { ok: true; ms: number | undefined } | { ok: false; error: string };

function resolveEffectiveInMs(choice: EffectiveChoice, customMinutes: string): Resolved {
  if (choice === "none") return { ok: true, ms: undefined };
  if (choice === "custom") {
    const n = parseMinutes(customMinutes);
    if (n === null) return { ok: false, error: "Enter a whole number of minutes (1 or more)." };
    return { ok: true, ms: n * 60_000 };
  }
  return { ok: true, ms: (EFFECTIVE_MINUTES[choice] ?? 0) * 60_000 };
}

function resolveExpiresInMs(choice: ExpiryChoice, customMinutes: string): Resolved {
  if (choice === "" || choice === "untilCancelled") return { ok: true, ms: undefined };
  if (choice === "custom") {
    const n = parseMinutes(customMinutes);
    if (n === null) return { ok: false, error: "Enter a whole number of minutes (1 or more)." };
    return { ok: true, ms: n * 60_000 };
  }
  return { ok: true, ms: (EXPIRY_MINUTES[choice] ?? 0) * 60_000 };
}

type Phase = "idle" | "confirmingReplace" | "submitting";

export function ComposeNoticeCard({
  activeNotice,
  activeNoticeLoaded,
  onPublished,
}: {
  activeNotice: SystemNoticeAdmin | null;
  /** True once the parent's own list fetch has resolved at least once — a
   *  submit is held back until then so a race can never publish without
   *  the replace-confirm this run's N1 requires (the parent load is fast;
   *  this only guards the narrow window before it resolves). */
  activeNoticeLoaded: boolean;
  onPublished: () => void;
}): React.JSX.Element {
  const [message, setMessage] = useState(CUSTOM_PRESET.message);
  const [severity, setSeverity] = useState<NoticeSeverity>(CUSTOM_PRESET.severity);
  const [effectiveChoice, setEffectiveChoice] = useState<EffectiveChoice>(CUSTOM_PRESET.effectiveChoice);
  const [effectiveCustomMinutes, setEffectiveCustomMinutes] = useState("");
  const [expiryChoice, setExpiryChoice] = useState<ExpiryChoice>(CUSTOM_PRESET.expiryChoice);
  const [expiryCustomMinutes, setExpiryCustomMinutes] = useState(CUSTOM_PRESET.expiryCustomMinutes);

  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pendingBody, setPendingBody] = useState<PublishSystemNoticeRequest | null>(null);

  // "Until cancelled" only exists for severity=critical — if the admin
  // switches severity away from critical while it's selected, fall back to
  // "no choice made yet" rather than silently keeping an option the select
  // no longer offers.
  useEffect(() => {
    if (severity !== "critical" && expiryChoice === "untilCancelled") setExpiryChoice("");
  }, [severity, expiryChoice]);

  function applyPreset(preset: PresetValues): void {
    setMessage(preset.message);
    setSeverity(preset.severity);
    setEffectiveChoice(preset.effectiveChoice);
    setEffectiveCustomMinutes("");
    setExpiryChoice(preset.expiryChoice);
    setExpiryCustomMinutes(preset.expiryCustomMinutes);
    setErrors({});
    setSubmitError(null);
    setPhase("idle");
    setPendingBody(null);
  }

  function handleMessageChange(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    // Hard-truncate the actual value — see this file's header on why
    // relying on the `maxLength` attribute alone isn't deterministic.
    setMessage(e.target.value.slice(0, MESSAGE_MAX));
  }

  function validate(): { ok: true; body: PublishSystemNoticeRequest } | { ok: false; errors: FormErrors } {
    const nextErrors: FormErrors = {};

    if (message.trim().length === 0) nextErrors.message = "Message is required.";
    else if (message.length > MESSAGE_MAX) nextErrors.message = `Message must be ${MESSAGE_MAX} characters or fewer.`;

    const effectiveResult = resolveEffectiveInMs(effectiveChoice, effectiveCustomMinutes);
    if (!effectiveResult.ok) nextErrors.effective = effectiveResult.error;

    const expiryResult = resolveExpiresInMs(expiryChoice, expiryCustomMinutes);
    if (!expiryResult.ok) nextErrors.expiry = expiryResult.error;

    if (severity === "warning" && expiryResult.ok && expiryResult.ms === undefined) {
      nextErrors.expiry = "Warning notices require an expiry.";
    }

    if (
      effectiveResult.ok &&
      expiryResult.ok &&
      effectiveResult.ms !== undefined &&
      expiryResult.ms !== undefined &&
      effectiveResult.ms > expiryResult.ms
    ) {
      nextErrors.cross = "The takes-effect time must not be after the expiry.";
    }

    if (Object.keys(nextErrors).length > 0) return { ok: false, errors: nextErrors };

    const body: PublishSystemNoticeRequest = { message, severity };
    if (effectiveResult.ok && effectiveResult.ms !== undefined) body.effectiveInMs = effectiveResult.ms;
    if (expiryResult.ok && expiryResult.ms !== undefined) body.expiresInMs = expiryResult.ms;
    return { ok: true, body };
  }

  async function submit(body: PublishSystemNoticeRequest): Promise<void> {
    setPhase("submitting");
    setSubmitError(null);
    try {
      await apiPost("/system/notices", { body });
      applyPreset(CUSTOM_PRESET);
      onPublished();
    } catch (err) {
      // InvitesPanel regression class: show the problem AND return to an
      // actionable form — never a stuck confirm/progress block.
      setSubmitError(err instanceof LoombreApiError ? err.message : "Failed to publish notice.");
      setPhase("idle");
      setPendingBody(null);
    }
  }

  function handlePublishClick(): void {
    const result = validate();
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSubmitError(null);
    if (activeNotice) {
      setPendingBody(result.body);
      setPhase("confirmingReplace");
    } else {
      void submit(result.body);
    }
  }

  return (
    <Card>
      <h2 className={styles.cardTitle}>Compose notice</h2>

      <p className={sharedStyles.note}>
        Notices are shown to every user on this server — never include restricted-zone references or personal
        information. A notice is communication only: publishing one does not restart, shut down, or otherwise change
        anything on the server by itself (use Settings → Server for that).
      </p>

      {phase !== "confirmingReplace" && (
        <div className={styles.presetsRow}>
          <Button type="button" variant="secondary" onClick={() => applyPreset(RESTART_PRESETS.restart5)}>
            Restart in 5 min
          </Button>
          <Button type="button" variant="secondary" onClick={() => applyPreset(RESTART_PRESETS.restart15)}>
            15 min
          </Button>
          <Button type="button" variant="secondary" onClick={() => applyPreset(RESTART_PRESETS.restart30)}>
            30 min
          </Button>
          <Button type="button" variant="secondary" onClick={() => applyPreset(MAINTENANCE_PRESET)}>
            Maintenance
          </Button>
          <Button type="button" variant="ghost" onClick={() => applyPreset(CUSTOM_PRESET)}>
            Custom
          </Button>
        </div>
      )}

      {phase === "confirmingReplace" && activeNotice ? (
        <div className={styles.confirmBlock}>
          <span className={styles.confirmText}>
            Replace the current notice? &ldquo;{truncateMessage(activeNotice.message, 80)}&rdquo; will stop showing
            immediately.
          </span>
          <div className={styles.confirmActions}>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingBody) void submit(pendingBody);
              }}
            >
              Replace
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPhase("idle");
                setPendingBody(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <form
          className={sharedStyles.form}
          onSubmit={(e) => {
            e.preventDefault();
            handlePublishClick();
          }}
        >
          <div className={sharedStyles.field}>
            <div className={styles.messageHeader}>
              <span className={sharedStyles.label}>Message</span>
              <span className={styles.charCounter} data-over={message.length >= MESSAGE_MAX || undefined}>
                {message.length}/{MESSAGE_MAX}
              </span>
            </div>
            <textarea
              className={sharedStyles.textarea}
              rows={3}
              maxLength={MESSAGE_MAX}
              value={message}
              onChange={handleMessageChange}
            />
            {errors.message && <p className={sharedStyles.errorText}>{errors.message}</p>}
          </div>

          <div className={sharedStyles.field}>
            <span className={sharedStyles.label}>Severity</span>
            <SegmentedControl
              key={severity}
              options={SEVERITY_OPTIONS.map((o) => o.label)}
              defaultValue={SEVERITY_LABEL[severity]}
              onChange={(label) => {
                const opt = SEVERITY_OPTIONS.find((o) => o.label === label);
                if (opt) setSeverity(opt.value);
              }}
            />
          </div>

          <div className={sharedStyles.field}>
            <span className={sharedStyles.label}>Takes effect</span>
            <select
              className={sharedStyles.textarea}
              value={effectiveChoice}
              onChange={(e) => setEffectiveChoice(e.target.value as EffectiveChoice)}
            >
              <option value="none">None — takes effect immediately</option>
              <option value="5">In 5 minutes</option>
              <option value="15">In 15 minutes</option>
              <option value="30">In 30 minutes</option>
              <option value="60">In 60 minutes</option>
              <option value="custom">Custom minutes…</option>
            </select>
            {effectiveChoice === "custom" && (
              <input
                className={`${sharedStyles.textarea} ${styles.customMinutesRow}`}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                placeholder="Minutes"
                value={effectiveCustomMinutes}
                onChange={(e) => setEffectiveCustomMinutes(e.target.value)}
              />
            )}
            {errors.effective && <p className={sharedStyles.errorText}>{errors.effective}</p>}
          </div>

          <div className={sharedStyles.field}>
            <span className={sharedStyles.label}>Expires</span>
            <select
              className={sharedStyles.textarea}
              value={expiryChoice}
              onChange={(e) => setExpiryChoice(e.target.value as ExpiryChoice)}
            >
              <option value="">Choose an expiry…</option>
              <option value="30m">30 minutes</option>
              <option value="1h">1 hour</option>
              <option value="4h">4 hours</option>
              <option value="24h">24 hours</option>
              <option value="custom">Custom minutes…</option>
              {severity === "critical" && <option value="untilCancelled">Until cancelled</option>}
            </select>
            {expiryChoice === "custom" && (
              <input
                className={`${sharedStyles.textarea} ${styles.customMinutesRow}`}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                placeholder="Minutes"
                value={expiryCustomMinutes}
                onChange={(e) => setExpiryCustomMinutes(e.target.value)}
              />
            )}
            {errors.expiry && <p className={sharedStyles.errorText}>{errors.expiry}</p>}
          </div>

          {errors.cross && <p className={sharedStyles.errorText}>{errors.cross}</p>}
          {submitError && <p className={sharedStyles.errorText}>{submitError}</p>}

          <div className={sharedStyles.actions}>
            <Button type="submit" variant="primary" disabled={phase === "submitting" || !activeNoticeLoaded}>
              {phase === "submitting" ? "Publishing…" : "Publish notice"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
