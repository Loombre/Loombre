// SPDX-License-Identifier: AGPL-3.0-only
import styles from "./ProgressBar.module.css";

export function ProgressBar({ percent }: { percent: number }): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className={styles.track} role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
      <div className={styles.fill} style={{ width: `${clamped}%` }} />
    </div>
  );
}

/** Non-interactive mock for the styleguide — the real player-lane scrubber
 *  (with drag physics) lands with the player surface, out of scope here. */
export function ScrubberMock({ percent }: { percent: number }): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className={styles.scrubberTrack}>
      <div className={styles.scrubberFill} style={{ width: `${clamped}%` }} />
      <div className={styles.scrubberHandle} style={{ left: `${clamped}%` }} />
    </div>
  );
}
