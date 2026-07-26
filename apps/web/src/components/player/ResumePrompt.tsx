// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/player/ResumePrompt.tsx
//
// Phosphor W2 lane L5 (resume-prompt + playback-refusal flows). design/
// phosphor/README.md "Interactions & behavior -> Resume prompt": "Playing
// anything with saved progress > 0 opens a prompt first, showing where you
// stopped, on which device, a progress bar, and two choices: `Resume from
// <pos>` or `Start over`. Never auto-resume without asking." §Screens ->
// Mobile phone-only additions lists "resume prompt" among the nine sheets
// — desktop dialog / phone bottom sheet is exactly SheetOrModal.tsx's job
// (Wave-1 W1b primitive), so this composes it rather than hand-rolling a
// second overlay shape.
//
// GROUND TRUTH on "on which device" (recorded here, not invented away):
// packages/contract/openapi.yaml's `Progress` schema — the ONLY payload
// GET /progress / GET /progress/{itemId} ever return, and the sole source
// `lib/progress-lookup.ts` has for a resumable position — carries
// `itemId/positionMs/durationMs/state/playCount/updatedAtMs` and NOTHING
// device-shaped. This isn't a contract-layer omission either: the `progress`
// table itself (packages/db/migrations/0001_init.sql) is keyed
// `(user_id, item_id)` with no device column at all — one merged position
// per user+item, not one per device. So there is no real "on which device"
// fact anywhere in this system today to show here. Per this lane's hard
// line ("no contract changes expected") and U9 (never fabricate a value),
// `deviceLabel` stays a real, honestly-optional prop: VideoPlayer.tsx
// currently always passes `null` (hidden), wired so a future lane that
// adds real per-device progress tracking can populate it without any
// redesign here. Reported as a finding in this lane's freeze report, not
// silently worked around.
//
// Dismissal (Escape / scrim-tap / the sheet's own Done button) maps to
// `onDismiss`, wired by VideoPlayer.tsx to the SAME `onBack` its own Back
// control uses — a LANE-DECIDED call: neither Resume nor Start Over is
// auto-selected on an unstructured dismiss (that would be exactly the
// "silent choice" the design forbids for playback refusal, applied here by
// the same principle), so dismissing leaves the user where they came from
// rather than guessing which of the two explicit choices they meant.

import { Button } from "../ui/Button.js";
import { ProgressBar } from "../ui/ProgressBar.js";
import { SheetOrModal } from "../ui/SheetOrModal.js";
import { defaultFormatTime } from "./Scrubber.js";
import styles from "./ResumePrompt.module.css";

export interface ResumePromptProps {
  open: boolean;
  positionMs: number;
  durationMs: number | null;
  /** See the header above — always `null` today (no real source exists),
   *  kept as an explicit, honestly-nullable prop rather than omitted. */
  deviceLabel: string | null;
  onResume: () => void;
  onStartOver: () => void;
  onDismiss: () => void;
}

/** "Resume from X / Start over" — shown once, before playback starts, when
 *  an existing in-progress Progress row exists. Desktop dialog / phone
 *  bottom sheet via SheetOrModal; both forms share this exact body. */
export function ResumePrompt({ open, positionMs, durationMs, deviceLabel, onResume, onStartOver, onDismiss }: ResumePromptProps): React.JSX.Element {
  const percent = durationMs && durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0;
  const positionLabel = defaultFormatTime(positionMs);

  return (
    <SheetOrModal open={open} onClose={onDismiss} title="Resume playback?" doneLabel="Close">
      <div className={styles.body}>
        <p className={styles.stopped}>
          You stopped at {positionLabel}
          {deviceLabel ? ` on ${deviceLabel}` : ""}.
        </p>
        <ProgressBar percent={percent} />
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onStartOver}>
            Start over
          </Button>
          <Button type="button" variant="primary" onClick={onResume}>
            Resume from {positionLabel}
          </Button>
        </div>
      </div>
    </SheetOrModal>
  );
}
