// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/detail/MarkWatchedButton.tsx
//
// Phosphor movie-detail "✓ Mark watched" action (design/phosphor/README.md
// "Movie detail"). Ground-truth check before building this (Phosphor W2 L4
// brief: "if a real endpoint exists ... wire the toggle; if nothing models
// watched-ness, STOP"): watched-state IS modeled — packages/db/migrations/
// 0001_init.sql's `progress` table has a real `state` column
// (watch_state: unplayed | in-progress | played), and
// `PUT /progress/{itemId}` (packages/contract/openapi.yaml) upserts it.
//
// The prototype itself only draws a stateless ACTION ("✓ Mark watched"
// always, no watched/unwatched visual states, no toggle-back — see the
// design bundle's mobMarkWatched handler, a one-way showToast). Since real
// progress data backs this, a one-way action would leave the button
// permanently claiming "not watched" after a real mark — a lane-decided
// upgrade to a genuine toggle (mark watched <-> mark unwatched) rather than
// reproducing that fixture-only limitation. Toast copy borrows the
// prototype's exact wording ("MARKED WATCHED · SYNCED TO ALL DEVICES");
// the unwatched-direction toast is the natural inverse, not in the
// prototype (no toggle-back existed there to draw one from).
//
// Purely a controlled presentational component — lib/use-watched-state.ts
// owns the fetch/toggle/optimistic-update logic. That split matters here
// specifically: this button renders TWICE per movie-detail page (the
// desktop and mobile action rows coexist in the DOM, CSS-swapped at the
// breakpoint), so a self-fetching version would double the real
// GET /progress/{itemId} call and risk the two instances' state drifting
// apart — see that hook's header.

import { Check } from "lucide-react";
import type { WatchedState } from "../../lib/use-watched-state.js";
import { Icon } from "../icon/Icon.js";
import styles from "./MarkWatchedButton.module.css";

export interface MarkWatchedButtonProps {
  state: WatchedState;
  busy: boolean;
  onToggle: () => void;
  /** Full-width 44px mobile treatment vs. the inline desktop pill — same
   *  component, CSS-only variant (matches the rest of this responsive
   *  tree's convention: no separate mobile component). */
  variant?: "desktop" | "mobile";
}

export function MarkWatchedButton({ state, busy, onToggle, variant = "desktop" }: MarkWatchedButtonProps): React.JSX.Element {
  const watched = state === "watched";
  return (
    <button
      type="button"
      className={styles.button}
      data-variant={variant}
      data-watched={watched}
      disabled={state === "loading" || busy}
      onClick={onToggle}
      aria-pressed={watched}
    >
      <Icon icon={Check} size="dense" aria-hidden />
      {watched ? "Watched" : "Mark watched"}
    </button>
  );
}
