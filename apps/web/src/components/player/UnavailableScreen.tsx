// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/player/UnavailableScreen.tsx
//
// Deliverable 2: typed unavailable state. Phase 3 §11 step 6c: since the
// server now plays direct-stream/remux/transcode sessions over HLS, this
// only renders for a REAL failure — POST /playback/sessions 409 (genuinely
// unplayable: refused tone-map or an empty ladder), 422, or 429 (transcode
// slots exhausted, lib/playback-reasons.ts's synthesized reason for that
// case). This is an exit-gate surface (hevc-10bit and PGS fixtures must
// render correct reasons) — every row maps a PLAYBACK.md §4 reason code to
// human copy via lib/playback-reasons.ts, with the raw code always shown
// alongside it.
//
// Phosphor W2 lane L5 (resume-prompt + playback-refusal flows) additions,
// per design/phosphor/README.md "Screens -> Playback unavailable" /
// "Interactions & behavior -> Playback refusal":
//   - a severity dot per reason row (blocking = danger red, informational =
//     warning amber — the same semantic pair Toast.tsx's dot already uses),
//     from `describeReasonCode(code).severity` — never a separately
//     invented classification.
//   - a fallback action naming a REAL alternative version, when one exists
//     (lib/playback-fallback.ts finds it against the real engine's own
//     `POST /playback/plan` preview — see that module's header for why no
//     codec/HDR claim is ever made here). `fallback` is `null` whenever no
//     alternate media file exists or every one is also refused — per the
//     design's own "when the plan offers one" qualifier, the whole block is
//     simply absent then, never a fabricated choice.
//   - desktop keeps this exact full-bleed panel (a SCREEN, not a dialog, per
//     the README's own Desktop section); phone renders the identical
//     reasons/fallback content inside a BottomSheet shell (README's Mobile
//     "phone-only additions" nine-sheet list names "playback-unavailable"
//     explicitly) — both share one `content` tree, never two copies.
//   - dismissing the phone sheet (Escape/scrim-tap/its own Done button) maps
//     to the SAME `onBack` the desktop Back button uses — declining/
//     dismissing always leaves the user exactly where they were, never
//     silently picks the fallback for them.

import { ArrowLeft, Sparkles } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Icon } from "../icon/Icon.js";
import { Tag } from "../ui/Chip.js";
import { Button } from "../ui/Button.js";
import { BottomSheet } from "../ui/BottomSheet.js";
import { useMediaQuery } from "../ui/use-media-query.js";
import { describeReasonCode } from "../../lib/playback-reasons.js";
import type { FallbackCandidate } from "../../lib/playback-fallback.js";
import { AmbientBackdrop } from "./AmbientBackdrop.js";
import styles from "./UnavailableScreen.module.css";

type PlanReason = components["schemas"]["PlanReason"];

// Same literal every other responsive seam in this app repeats (tokens.css
// "Mobile chrome layout" note is the single source of truth; SheetOrModal.tsx
// carries the identical JS-side matchMedia copy this file mirrors).
const PHONE_QUERY = "(max-width: 767.98px)";

export interface UnavailableScreenProps {
  title: string;
  backdropUrl: string | null;
  dominantColor: string | null;
  reasons: PlanReason[];
  /**
   * H12 fix (Wave-3 fidelity audit): the real HTTP status the failed
   * createPlaybackSession/createDirectPlaySession call received (409
   * genuinely-unplayable, 429 transcode-slots-exhausted —
   * lib/playback-reasons.ts's `resolveUnavailableReasons` threads a real
   * `status: number` through at both of VideoPlayer.tsx's call sites).
   * VideoPlayer.tsx DOES wire it: `setUnavailableStatus(result.status)`
   * on both the session-create and fallback-accept failure paths, passed
   * here as `statusCode={unavailableStatus}`. Kept optional because the
   * status is genuinely unknown until a create call has failed (and for
   * any future caller without one) — when `undefined`, the status pill
   * renders "Session refused" alone rather than a fabricated code.
   */
  statusCode?: number | undefined;
  /** A real alternate media file the engine does NOT refuse, or `null` when
   *  none exists / every one is also refused (lib/playback-fallback.ts). */
  fallback: FallbackCandidate | null;
  onAcceptFallback: (candidate: FallbackCandidate) => void;
  onBack: () => void;
}

export function UnavailableScreen({ title, backdropUrl, dominantColor, reasons, statusCode, fallback, onAcceptFallback, onBack }: UnavailableScreenProps): React.JSX.Element {
  const isPhone = useMediaQuery(PHONE_QUERY);

  const reasonList = (
    <div className={styles.reasonList}>
      {reasons.length === 0 ? (
        <div className={styles.reasonRow}>
          <span className={styles.reasonTitle}>No specific reason was reported.</span>
        </div>
      ) : (
        reasons.map((reason, i) => {
          const copy = describeReasonCode(reason.code);
          return (
            <div className={styles.reasonRow} key={`${reason.code}-${i}`}>
              <span className={styles.reasonHeading}>
                <span className={styles.severityDot} data-severity={copy.severity} aria-hidden="true" />
                <span className={styles.reasonTitle}>{copy.title}</span>
              </span>
              <span className={styles.reasonDetail}>{copy.detail}</span>
              <span className={styles.reasonCode}>
                {reason.code}
                {reason.streamIndex !== null && reason.streamIndex !== undefined ? ` · stream ${reason.streamIndex}` : ""}
                {reason.detail ? ` · ${reason.detail}` : ""}
              </span>
            </div>
          );
        })
      )}
    </div>
  );

  const fallbackBlock = fallback ? (
    <div className={styles.fallbackBlock}>
      <p className={styles.fallbackNote}>A different version of this title can play instead.</p>
      <Button type="button" variant="primary" onClick={() => onAcceptFallback(fallback)}>
        Play the {fallback.label} version
      </Button>
    </div>
  ) : null;

  const content = (
    <>
      <div className={styles.statusRow}>
        <span className={styles.statusPill}>Session refused{statusCode !== undefined ? ` · HTTP ${statusCode}` : ""}</span>
        <span className={styles.statusNote}>Planner reasons, verbatim</span>
      </div>
      <Tag>
        <Icon icon={Sparkles} size="dense" aria-hidden />
        Can’t play this right now
      </Tag>
      <h1 className={styles.title}>“{title}” can’t play on this device right now</h1>
      <p className={styles.subtitle}>Here’s exactly why:</p>
      {reasonList}
      {fallbackBlock}
    </>
  );

  if (isPhone) {
    return (
      <div className={styles.wrap}>
        <AmbientBackdrop imageUrl={backdropUrl} dominantColor={dominantColor} />
        <BottomSheet open onClose={onBack} title="Can’t play this right now" doneLabel="Back">
          <div className={styles.sheetBody}>{content}</div>
        </BottomSheet>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <AmbientBackdrop imageUrl={backdropUrl} dominantColor={dominantColor} />
      <div className={styles.panel}>
        {content}
        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onBack}>
            <Icon icon={ArrowLeft} size="dense" />
            Back
          </Button>
        </div>
      </div>
    </div>
  );
}
