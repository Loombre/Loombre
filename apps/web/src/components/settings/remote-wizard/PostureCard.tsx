// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/PostureCard.tsx
//
// R7's exposure-aware posture card (STATE.md "Loombre Remote ...", mission
// item 1, lane U3). Fetches GET /admin/remote/posture (S1's real
// implementation — DRIFT DECISION #1, no 501 interim) and renders the
// per-check StatusPill rows + overallGrade summary + evaluatedAt
// timestamp. Rendered through PostureCardSlot.tsx, U1's ONE seam
// (PathManagementCard.tsx + PostureHandoffStage.tsx both mount that slot),
// so this component itself lands in exactly one place despite being
// visible from two surfaces.
//
// `checks` empty is rendered as an honest inapplicable state (posture-
// model.ts's deriveCardState: empty means the SERVER's own view is that no
// path is active) rather than the card vanishing — a caller always passes
// a definite `activePath` (both mount sites only render the slot once a
// path IS active locally), but the server's own read is the source of
// truth for what to grade, and a brief mismatch (e.g. mid-teardown) is
// exactly when an honest explanation matters most.
//
// Live refresh (NoticesSection.tsx precedent, "refetch, never trust
// payloads"): subscribes to posture.regressed/posture.recovered on the
// shared events socket and calls refetch(), ignoring the event payload
// entirely. Plus a modest poll fallback while this component is mounted
// (HardwareStep.tsx's setInterval-while-mounted precedent) so the card
// self-heals even if a socket event is missed or the socket is
// disconnected.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import type { components } from "@loombre/sdk";
import type { PathId } from "@loombre/shared/remote";
import { StatusPill } from "../../admin/StatusPill.js";
import { EmptyState } from "../../admin/EmptyState.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import type { PillTone } from "../../../lib/admin-status.js";
import { apiGet } from "../../../lib/api-client.js";
import { apiErrorMessage } from "../../../lib/api-error-message.js";
import { getEventsSocket } from "../../../lib/events-socket.js";
import { PATH_LABELS } from "./path-labels.js";
import styles from "./PostureCard.module.css";

type RemotePostureCard = components["schemas"]["RemotePostureCard"];
type RemotePostureCheck = components["schemas"]["RemotePostureCheck"];
type RemotePostureGrade = components["schemas"]["RemotePostureGrade"];
type RemotePostureCheckKey = components["schemas"]["RemotePostureCheckKey"];

/** Modest poll fallback (HardwareStep.tsx precedent is 4s for an active
 *  setup step waiting on one probe; this is a persistent admin card, not a
 *  step blocking progress, so a slower interval is the honest "modest"
 *  reading of the mission brief — the socket subscription below is the
 *  primary freshness signal, this is only the fallback. */
const POLL_INTERVAL_MS = 30_000;

const GRADE_INFO: Record<RemotePostureGrade, { label: string; tone: PillTone }> = {
  pass: { label: "Pass", tone: "success" },
  info: { label: "Info", tone: "info" },
  warn: { label: "Warn", tone: "warning" },
  fail: { label: "Fail", tone: "danger" },
};

/** Human titles for posture-model.ts's frozen POSTURE_CHECK_KEYS — the
 *  contract enum is machine-cased (camelCase), this is display-only. */
const CHECK_TITLES: Record<RemotePostureCheckKey, string> = {
  tlsValidity: "TLS certificate",
  rateLimitersActive: "Rate limiting",
  staleAccounts: "Stale accounts",
  inviteLinksReachable: "Invite link exposure",
  wgPortSilence: "WireGuard port silence",
  connectorHealth: "Tunnel connector",
  publicUrlCoherence: "Public URL setting",
};

function formatEvaluatedAt(ms: number): string {
  return new Date(ms).toLocaleString();
}

function CheckRow({ check }: { check: RemotePostureCheck }): React.JSX.Element {
  const info = GRADE_INFO[check.grade];
  return (
    <li className={styles.checkRow}>
      <StatusPill label={info.label} tone={info.tone} />
      <div className={styles.checkBody}>
        <span className={styles.checkTitle}>{CHECK_TITLES[check.key]}</span>
        <span className={styles.checkDetail}>{check.detail}</span>
      </div>
      <Link href={check.fixAction.href} className={styles.fixLink}>
        {check.fixAction.label}
      </Link>
    </li>
  );
}

export interface PostureCardProps {
  /** The caller's own idea of the active path — used only to word the
   *  empty state honestly; the checks and overall grade always come from
   *  the server's own evaluation, never from this prop. */
  activePath: PathId;
}

export function PostureCard({ activePath }: PostureCardProps): React.JSX.Element {
  const [card, setCard] = useState<RemotePostureCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    apiGet("/admin/remote/posture")
      .then((res) => {
        setCard(res);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(apiErrorMessage(err, "Failed to load security posture."));
      });
  }, []);

  useEffect(() => {
    refetch();
    const timer = setInterval(refetch, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refetch]);

  useEffect(() => {
    const socket = getEventsSocket();
    const unsubRegressed = socket.subscribe("posture.regressed", () => refetch());
    const unsubRecovered = socket.subscribe("posture.recovered", () => refetch());
    return () => {
      unsubRegressed();
      unsubRecovered();
    };
  }, [refetch]);

  if (!card && !error) {
    return (
      <div className={styles.card}>
        <Skeleton radius="md" height={120} />
      </div>
    );
  }

  return (
    <div className={styles.card} data-testid="posture-card">
      <div className={styles.header}>
        <p className={styles.label}>Security posture</p>
        {card && <StatusPill label={GRADE_INFO[card.overallGrade].label} tone={GRADE_INFO[card.overallGrade].tone} />}
      </div>

      {error && <p className={styles.errorText}>{error}</p>}

      {card && card.checks.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          title="No checks apply right now"
          body={`The posture card activates once a remote-access path is enabled — the server reports nothing to grade for ${PATH_LABELS[activePath]} at the moment.`}
        />
      )}

      {card && card.checks.length > 0 && (
        <>
          <p className={styles.evaluatedAt}>Checked {formatEvaluatedAt(card.evaluatedAtMs)}</p>
          <ul className={styles.checks}>
            {card.checks.map((check) => (
              <CheckRow key={check.key} check={check} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
