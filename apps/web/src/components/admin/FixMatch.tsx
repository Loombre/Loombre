// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/FixMatch.tsx
//
// REUSABLE, item-scoped Fix Match flow (Phosphor retheme Wave 2, Lane L2 —
// design/phosphor/README.md "Interactions & behavior → Scanning": "n
// UNMATCHED · REVIEW expands per-file errors; fixable ones offer FIX
// MATCH, which opens a candidate list with confidence bars and a BEST
// badge; applying re-fetches artwork and NFO and never touches the
// original file"). Lane L2 owns this component for the WHOLE Phosphor run
// — sibling lane L4 (movie-detail's own METADATA card FIX MATCH action)
// reuses it sight-unseen at landing. Do not fork or duplicate it.
//
// ── PUBLIC PROPS API (the whole contract a consumer needs) ─────────────
//   itemId     — the catalog item to search/apply a match for (required).
//                Every request this component makes is scoped to this id
//                (POST /admin/items/{itemId}/match-search|apply-match —
//                both are item-scoped operations, contract-first).
//   itemTitle  — display title shown in the sheet/modal header (the
//                caller already has this from its own list/detail data;
//                this component never fetches it itself).
//   fileId     — RESERVED for a future per-file-scoped flow (e.g. an item
//                with multiple version files that might eventually want
//                independent matches per file). NOT read by this
//                component today — both backing endpoints are item-scoped,
//                not file-scoped. Accepted now so no consumer needs a
//                breaking prop-shape change if that lands later.
//   open       — controlled visibility (mirrors SheetOrModal's own API,
//   onClose      which this component renders internally — callers never
//                import SheetOrModal/BottomSheet themselves; on phone this
//                is a bottom sheet, at desktop width a dialog, entirely by
//                construction).
//   onApplied  — fires once POST .../apply-match successfully ENQUEUES a
//                job (not once the worker finishes applying it — that is
//                async, see the toast copy below). Callers typically
//                refetch their own list and/or rely on the toast alone.
//
// ── Internal flow ───────────────────────────────────────────────────────
// On open: enqueues a bounded metadata-provider search
// (POST .../match-search, CLAUDE.md invariant 6 — no provider I/O inline
// in ANY request path, including this one) and subscribes to the shared
// events socket for this item's admin-only `metadata.match-candidates`
// result (delivered by apps/worker/src/metadata/match-search-consumer.ts).
// Renders the ranked list with confidence bars once it arrives — a BEST
// badge on the top-scored candidate (apps/worker/src/metadata/match.ts's
// scoring). Applying a candidate POSTs .../apply-match, which rides the
// EXISTING 'metadata' job/consumer (never a bespoke pipeline, never inline
// provider I/O) and never touches the original media file.
//
// ── Empty results are two different states (d4-e1, backlog #081) ────────
// "Every provider was asked and none matched" and "no provider was asked"
// are opposites — the second is what a keyless instance ALWAYS looks like,
// and it is the only one an admin can act on — but the event carried just
// candidates[], so this sheet rendered "No metadata provider in this item's
// chain returned a match" for both, i.e. it described a search that never
// ran. The payload now carries `providersSearched`; an EMPTY array means the
// chain resolved and everything in it was disabled, and that state gets its
// own copy plus the route to Settings → Plugins. The field being ABSENT
// (older server, or a job that never reached the search stage) keeps the
// original sentence — an unknown must not become an accusation.
// The instance-wide hints (ProviderKeysNoticeCard on /admin, ProviderKeysCard
// on /settings/plugins) still exist and are still right; this one lives where
// the emptiness is actually noticed.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, KeyRound } from "lucide-react";
import { SheetOrModal } from "../ui/SheetOrModal.js";
import { Button } from "../ui/Button.js";
import { ProgressBar } from "../ui/ProgressBar.js";
import { Tag } from "../ui/Chip.js";
import { Skeleton } from "../skeleton/Skeleton.js";
import { EmptyState } from "./EmptyState.js";
import { apiPost, LoombreApiError } from "../../lib/api-client.js";
import { getEventsSocket, type EventEnvelope } from "../../lib/events-socket.js";
import { useToast } from "../ui/Toast.js";
import styles from "./FixMatch.module.css";

interface MatchCandidate {
  provider: string;
  externalId: string;
  title: string;
  year: number | null;
  confidence: number;
  isBest: boolean;
}

interface MatchCandidatesPayload {
  itemId: string;
  jobId: string;
  candidates: MatchCandidate[];
  /** d4-e1: who the search actually asked (see this file's header). Absent
   *  from an older server, and from a result where no search stage was
   *  reached — both fall back to the generic empty-state copy. */
  providersSearched?: string[];
  searchedAtMs: number;
}

type SearchState =
  | { kind: "searching" }
  | { kind: "results"; candidates: MatchCandidate[]; providersSearched: string[] | undefined }
  | { kind: "error"; message: string };

export interface FixMatchProps {
  /** The catalog item to search/apply a match for. */
  itemId: string;
  /** Display title for the sheet/modal header. */
  itemTitle: string;
  /** Reserved for a future per-file-scoped flow — see this file's header. */
  fileId?: string | null;
  open: boolean;
  onClose: () => void;
  /** Fires once apply-match successfully ENQUEUES (not once applied). */
  onApplied: () => void;
}

export function FixMatch({ itemId, itemTitle, open, onClose, onApplied }: FixMatchProps): React.JSX.Element {
  const [state, setState] = useState<SearchState>({ kind: "searching" });
  const [applyingKey, setApplyingKey] = useState<string | null>(null);
  const { showToast } = useToast();
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!open) return undefined;
    cancelledRef.current = false;
    setState({ kind: "searching" });

    const socket = getEventsSocket();
    const unsubscribe = socket.subscribe<MatchCandidatesPayload>(
      "metadata.match-candidates",
      (event: EventEnvelope<MatchCandidatesPayload>) => {
        if (cancelledRef.current || event.payload.itemId !== itemId) return;
        setState({ kind: "results", candidates: event.payload.candidates, providersSearched: event.payload.providersSearched });
      },
    );

    apiPost("/admin/items/{id}/match-search", { params: { path: { id: itemId } } }).catch((err) => {
      if (cancelledRef.current) return;
      setState({ kind: "error", message: err instanceof LoombreApiError ? err.message : "Failed to start the search." });
    });

    return () => {
      cancelledRef.current = true;
      unsubscribe();
    };
  }, [open, itemId]);

  async function applyCandidate(candidate: MatchCandidate): Promise<void> {
    const key = `${candidate.provider}:${candidate.externalId}`;
    setApplyingKey(key);
    try {
      await apiPost("/admin/items/{id}/apply-match", {
        params: { path: { id: itemId } },
        body: { provider: candidate.provider, externalId: candidate.externalId },
      });
      showToast("MATCH APPLIED · REFETCHING ARTWORK");
      onApplied();
      onClose();
    } catch (err) {
      showToast(err instanceof LoombreApiError ? err.message : "Failed to apply match.", { variant: "danger" });
    } finally {
      setApplyingKey(null);
    }
  }

  return (
    <SheetOrModal open={open} onClose={onClose} title="Fix match" sub={itemTitle}>
      <div className={styles.body}>
        {state.kind === "searching" && (
          <div className={styles.skeletonList} aria-hidden="true">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} radius="md" height={72} />
            ))}
          </div>
        )}
        {state.kind === "error" && <p className={styles.errorText}>{state.message}</p>}
        {/* d4-e1: an empty result has two opposite causes and only one of
            them is the admin's to fix. providersSearched === [] means the
            chain was resolved and every provider in it was skipped as
            disabled — the shape of a keyless instance — so nothing was
            searched and the honest thing to show is where the key goes.
            Absent (older server, or a result that never reached the search
            stage) keeps the original sentence. */}
        {state.kind === "results" && state.candidates.length === 0 && state.providersSearched?.length === 0 && (
          <>
            <EmptyState
              icon={KeyRound}
              title="Nothing was searched"
              body="This item's provider chain has no enabled metadata provider — Fix Match cannot look for candidates until at least one provider key is set."
            />
            <Link href="/settings/plugins" className={styles.keysLink}>
              Configure provider keys
            </Link>
          </>
        )}
        {state.kind === "results" && state.candidates.length === 0 && state.providersSearched?.length !== 0 && (
          <EmptyState
            icon={CheckCircle2}
            title="No candidates found"
            body="No metadata provider in this item's chain returned a match for this title."
          />
        )}
        {state.kind === "results" && state.candidates.length > 0 && (
          <ul className={styles.candidateList}>
            {state.candidates.map((candidate) => {
              const key = `${candidate.provider}:${candidate.externalId}`;
              return (
                <li key={key} className={styles.candidateRow} data-best={candidate.isBest}>
                  <div className={styles.candidateMain}>
                    <span className={styles.candidateTitle}>
                      {candidate.title}
                      {candidate.year !== null && <span className={styles.candidateYear}> ({candidate.year})</span>}
                    </span>
                    {candidate.isBest && <Tag>BEST</Tag>}
                  </div>
                  <div className={styles.candidateMeta}>
                    <span className={styles.providerName}>{candidate.provider}</span>
                    <div className={styles.confidenceWrap}>
                      <ProgressBar percent={candidate.confidence} />
                      <span className={styles.confidenceLabel}>{Math.round(candidate.confidence)}%</span>
                    </div>
                  </div>
                  <Button
                    variant={candidate.isBest ? "primary" : "secondary"}
                    onClick={() => void applyCandidate(candidate)}
                    disabled={applyingKey !== null}
                  >
                    {applyingKey === key ? "Applying…" : "Apply"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SheetOrModal>
  );
}
