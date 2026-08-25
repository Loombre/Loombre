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
//
// LD-1 fix (owner-reported, annotated screenshot, 2026-08-10): two changes
// to the SESSION-REFUSED presentation, applying to every unavailable
// variant (a real 409/422/429 AND the client-synthesized
// `clientPlaybackErrorReasons()` path VideoPlayer.tsx's recovery machinery
// falls through to — both just set `reasons`/`statusCode` the same way, so
// nothing here branches on which one it is):
//   (a) the yellow "Can't play this right now" sparkle `<Tag>` banner is
//       gone entirely — it repeated the status pill's own message with no
//       new information.
//   (b) the desktop Back button moved from a bottom `.footer` row to the
//       TOP of the card, sharing `.header` with the status/badge row it
//       used to sit below — Back is far-left, the SESSION REFUSED · HTTP
//       nnn badge row shifts right of it. `.header` is desktop-only (not
//       part of the shared `content`/`statusRow` trees below): the phone
//       BottomSheet already has its own top-of-sheet "Back" done-button
//       (see the phone branch), so putting Back inside the shared trees
//       would duplicate it there.

import { ArrowLeft } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Icon } from "../icon/Icon.js";
import { Button } from "../ui/Button.js";
import { BottomSheet } from "../ui/BottomSheet.js";
import { useMediaQuery } from "../ui/use-media-query.js";
import { describeReasonCode } from "../../lib/playback-reasons.js";
import { describeSessionFailureCode } from "../../lib/playback-recovery.js";
import type { FallbackCandidate } from "../../lib/playback-fallback.js";
import { AmbientBackdrop } from "./AmbientBackdrop.js";
import styles from "./UnavailableScreen.module.css";

type PlanReason = components["schemas"]["PlanReason"];

// Same literal every other responsive seam in this app repeats (tokens.css
// "Mobile chrome layout" note is the single source of truth; SheetOrModal.tsx
// carries the identical JS-side matchMedia copy this file mirrors).
const PHONE_QUERY = "(max-width: 767.98px)";

/**
 * d3-aq6 (A/browser-player-F1): which FRAMING this screen wears. Three
 * paths reach it and only one of them is a refusal:
 *  - `refused`     — the planner said no (a real 409/422/429, or the
 *                    client-synthesized equivalents): rows are §4 planner
 *                    reasons. THE DEFAULT, byte-for-byte the copy this
 *                    screen has always shown.
 *  - `failed`      — a session the SERVER killed mid-playback: rows are
 *                    `playback_sessions.error_code` runtime codes, and
 *                    nothing about it was "refused" — playback had
 *                    already started.
 *  - `unavailable` — /watch could never resolve the item at all (no
 *                    session was ever planned, so there are no planner
 *                    reasons to be verbatim about).
 * The variant selects labels ONLY: reasons, fallback, backdrop and both
 * layouts are identical across all three.
 */
export type UnavailableVariant = "refused" | "failed" | "unavailable";

interface UnavailableCopy {
  /** Status pill, before the ` · HTTP nnn` suffix. */
  status: string;
  /** The note beside the pill, naming what the rows below actually are. */
  note: string;
  heading: (title: string) => string;
  subheading: string;
  /** The phone BottomSheet's own title/accessible heading. */
  sheetTitle: string;
}

const VARIANT_COPY: Record<UnavailableVariant, UnavailableCopy> = {
  refused: {
    status: "Session refused",
    note: "Planner reasons, verbatim",
    heading: (title) => `“${title}” can’t play on this device right now`,
    subheading: "Here’s exactly why:",
    sheetTitle: "Can’t play this right now",
  },
  failed: {
    status: "Session failed",
    note: "Server error codes, verbatim",
    heading: (title) => `“${title}” stopped playing`,
    subheading: "Here’s what the server reported:",
    sheetTitle: "Playback stopped",
  },
  unavailable: {
    status: "Unavailable",
    note: "Details, verbatim",
    heading: (title) => `“${title}” isn’t available right now`,
    subheading: "Here’s what we know:",
    sheetTitle: "This can’t be played",
  },
};

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
  /** Which framing to wear (see `UnavailableVariant`). Optional and
   *  defaulting to `"refused"`: every existing call site keeps the exact
   *  copy it had before this prop existed. */
  variant?: UnavailableVariant | undefined;
  /** A real alternate media file the engine does NOT refuse, or `null` when
   *  none exists / every one is also refused (lib/playback-fallback.ts). */
  fallback: FallbackCandidate | null;
  onAcceptFallback: (candidate: FallbackCandidate) => void;
  onBack: () => void;
}

export function UnavailableScreen({ title, backdropUrl, dominantColor, reasons, statusCode, variant = "refused", fallback, onAcceptFallback, onBack }: UnavailableScreenProps): React.JSX.Element {
  const isPhone = useMediaQuery(PHONE_QUERY);
  // Not `copy` — the reason rows below already bind that name per reason.
  const framing = VARIANT_COPY[variant];

  const reasonList = (
    <div className={styles.reasonList}>
      {reasons.length === 0 ? (
        <div className={styles.reasonRow}>
          <span className={styles.reasonTitle}>No specific reason was reported.</span>
        </div>
      ) : (
        reasons.map((reason, i) => {
          // browser-player-F1: a session the SERVER marked failed
          // mid-playback reaches this screen carrying its
          // playback_sessions.error_code (goFatal in VideoPlayer.tsx,
          // sessionFailureReasons in lib/playback-recovery.ts) — those are
          // runtime session-death codes, not §4 PlanReasonCodes, so they
          // get their own copy map first; every plan reason falls through
          // to describeReasonCode exactly as before.
          const copy = describeSessionFailureCode(reason.code) ?? describeReasonCode(reason.code);
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

  // The status/badge row — shared by both forms (part of the phone sheet
  // body, and combined with the desktop-only Back button in `.header`
  // below), never duplicated.
  const statusRow = (
    <div className={styles.statusRow}>
      <span className={styles.statusPill}>
        {framing.status}
        {statusCode !== undefined ? ` · HTTP ${statusCode}` : ""}
      </span>
      <span className={styles.statusNote}>{framing.note}</span>
    </div>
  );

  const content = (
    <>
      <h1 className={styles.title}>{framing.heading(title)}</h1>
      <p className={styles.subtitle}>{framing.subheading}</p>
      {reasonList}
      {fallbackBlock}
    </>
  );

  if (isPhone) {
    return (
      <div className={styles.wrap}>
        <AmbientBackdrop imageUrl={backdropUrl} dominantColor={dominantColor} />
        <BottomSheet open onClose={onBack} title={framing.sheetTitle} doneLabel="Back">
          <div className={styles.sheetBody}>
            {statusRow}
            {content}
          </div>
        </BottomSheet>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <AmbientBackdrop imageUrl={backdropUrl} dominantColor={dominantColor} />
      <div className={styles.panel}>
        <div className={styles.header}>
          <Button type="button" variant="secondary" onClick={onBack}>
            <Icon icon={ArrowLeft} size="dense" />
            Back
          </Button>
          {statusRow}
        </div>
        {content}
      </div>
    </div>
  );
}
