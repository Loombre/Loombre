// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/PlayLink.tsx
//
// Just a link to lane (ii)'s player route — this lane does not build the
// player itself (file ownership: app/watch/** belongs to lane (ii)).

import { Icon } from "../icon/Icon.js";
import styles from "./PlayLink.module.css";

export function PlayLink({ itemId }: { itemId: string }): React.JSX.Element {
  return (
    <a href={`/watch/${itemId}`} className={styles.button}>
      <Icon icon="play" size="dense" aria-hidden />
      Play
    </a>
  );
}
