// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import styles from "./Card.module.css";

export function Card({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={className ? `${styles.card} ${className}` : styles.card}>{children}</div>;
}

/**
 * S4 fix (Wave-3 fidelity audit): a stable per-label hue rather than a
 * flat accent fill — design/phosphor/Loombre Phosphor.dc.html derives
 * every avatar's background from a `hue` field (person cards, cast rows,
 * sidebar user row: `oklch(0.4-0.5 0.09-0.11 {{ hue }})`). No `id` is
 * threaded to this component today (every call site only has a display
 * label), so the hash runs over `label` itself — stable for as long as a
 * name doesn't change, which is the same stability guarantee the
 * prototype's own per-fixture hue values have. A simple string hash
 * (not cryptographic — this is decorative, not a security boundary).
 */
function hashHue(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** 2-letter initials (S4 — prototype's `initials` fixtures are always
 *  2 characters). First-letter-of-first-two-words for a multi-word label
 *  ("Maya Reyes" -> "MR"); the first two characters of a single-word
 *  label (a bare username, e.g. "admin" -> "AD") so the avatar is never
 *  visually thinner than every other one for lack of a space. */
function initialsFor(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
  }
  const single = words[0] ?? "";
  return single.slice(0, 2).toUpperCase() || "?";
}

export function Avatar({ label, size = 36 }: { label: string; size?: number }): React.JSX.Element {
  const hue = hashHue(label);
  return (
    <span
      className={styles.avatar}
      style={{ width: size, height: size, background: `oklch(0.5 0.11 ${hue})` }}
      aria-label={label}
      role="img"
    >
      {initialsFor(label)}
    </span>
  );
}
