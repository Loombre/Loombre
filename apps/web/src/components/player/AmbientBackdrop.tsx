// SPDX-License-Identifier: AGPL-3.0-only
import styles from "./AmbientBackdrop.module.css";

export interface AmbientBackdropProps {
  imageUrl: string | null;
  dominantColor: string | null;
}

/** P2.11: blurred item backdrop + dominant-color glow, rendered behind the
 *  player's idle/paused state and the unavailable screen. */
export function AmbientBackdrop({ imageUrl, dominantColor }: AmbientBackdropProps): React.JSX.Element {
  return (
    <div className={styles.wrap} aria-hidden="true">
      {imageUrl && <img className={styles.image} src={imageUrl} alt="" />}
      <div className={styles.scanlines} />
      <div className={styles.glow} style={dominantColor ? ({ "--glow-color": dominantColor } as React.CSSProperties) : undefined} />
      <div className={styles.scrim} />
    </div>
  );
}
