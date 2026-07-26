// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/ReasonsPanel.tsx
//
// Phase 4 deliverable D: the Sessions panel's "why is this transcoding"
// view. `plan` is the session's OWN stored docs/PLAYBACK.md §5 plan
// (additive wire field on AdminSession — see apps/server/src/catalog/
// admin.controller.ts's header for the discovered-contract-gap writeup;
// null when the admin isn't cleared to see this session's content, same
// redaction as itemTitle). Reuses describeReasonCode (lib/playback-
// reasons.ts) for copy — one reason-code copy map for the whole app, not
// a separate admin-only one.

import { describeReasonCode } from "../../lib/playback-reasons.js";
import styles from "./ReasonsPanel.module.css";

interface PlanReasonLike {
  code: string;
  streamIndex?: number | null;
  detail?: string | null;
}

interface LadderRungLike {
  heightPx: number;
  videoBitrateBps: number;
  codec: string;
}

function isPlanReasonLike(v: unknown): v is PlanReasonLike {
  return typeof v === "object" && v !== null && typeof (v as { code?: unknown }).code === "string";
}

function asReasons(plan: Record<string, unknown>): PlanReasonLike[] {
  const raw = plan["reasons"];
  return Array.isArray(raw) ? raw.filter(isPlanReasonLike) : [];
}

function asLadder(plan: Record<string, unknown>): LadderRungLike[] {
  const raw = plan["ladder"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is LadderRungLike =>
      typeof r === "object" && r !== null && typeof (r as { heightPx?: unknown }).heightPx === "number",
  );
}

function formatMbps(bps: number): string {
  return `${(bps / 1_000_000).toFixed(1)} Mbps`;
}

export function ReasonsPanel({ plan, contentHidden }: { plan: Record<string, unknown> | null; contentHidden: boolean }): React.JSX.Element {
  if (contentHidden) {
    return (
      <p className={styles.hidden}>
        This session's plan is hidden — you aren't currently cleared to see this restricted item (unlock restricted
        content to view why it's playing the way it is).
      </p>
    );
  }
  if (!plan) {
    return <p className={styles.hidden}>No plan recorded for this session yet.</p>;
  }

  const decision = typeof plan["decision"] === "string" ? plan["decision"] : "unknown";
  const engineVersion = typeof plan["engineVersion"] === "string" ? plan["engineVersion"] : null;
  const reasons = asReasons(plan);
  const ladder = asLadder(plan);

  return (
    <div className={styles.panel}>
      <div className={styles.decisionRow}>
        <span className={styles.decisionLabel}>Decision</span>
        <span className={styles.decisionValue} data-decision={decision}>
          {decision}
        </span>
        {engineVersion && <span className={styles.engineVersion}>engine {engineVersion}</span>}
      </div>

      {reasons.length === 0 ? (
        <p className={styles.noReasons}>No reasons reported — direct play, nothing to explain.</p>
      ) : (
        <ul className={styles.reasonList}>
          {reasons.map((reason, i) => {
            const copy = describeReasonCode(reason.code);
            return (
              <li key={`${reason.code}-${i}`} className={styles.reasonItem} data-severity={copy.severity}>
                <div className={styles.reasonHeader}>
                  <span className={styles.reasonTitle}>{copy.title}</span>
                  <span className={styles.reasonSeverity}>{copy.severity}</span>
                </div>
                <p className={styles.reasonDetail}>{reason.detail ?? copy.detail}</p>
                <code className={styles.reasonCode}>{reason.code}</code>
              </li>
            );
          })}
        </ul>
      )}

      {ladder.length > 0 && (
        <div className={styles.ladder}>
          <span className={styles.ladderLabel}>Bitrate ladder</span>
          <div className={styles.ladderRungs}>
            {ladder.map((rung, i) => (
              <span key={i} className={styles.rung}>
                {rung.heightPx}p · {rung.codec} · {formatMbps(rung.videoBitrateBps)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
