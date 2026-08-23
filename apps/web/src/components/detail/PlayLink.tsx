// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/PlayLink.tsx
//
// Just a link to lane (ii)'s player route — this lane does not build the
// player itself (file ownership: app/watch/** belongs to lane (ii)).
//
// It MUST be a next/link, never a raw <a href> (QA browser-items-F1):
// app/watch/[itemId]/page.tsx's audio branch hands the track to the
// MusicPlayerProvider mounted ABOVE the route (AppProviders) and then calls
// router.back(). A raw anchor makes that a cross-document trip — the
// provider that receives playTrack() belongs to the throwaway /watch
// document and dies with it on the back traversal, so the user returns to
// an empty queue with no MiniPlayerBar and no error. Client-side
// navigation keeps one document (and one provider) across the whole
// handoff, and is also what makes /watch's React unmount path real for the
// video branch. Guarded by PlayLink.test.tsx.

import Link from "next/link";
import { Icon } from "../icon/Icon.js";
import styles from "./PlayLink.module.css";

export function PlayLink({ itemId }: { itemId: string }): React.JSX.Element {
  return (
    <Link href={`/watch/${itemId}`} className={styles.button}>
      <Icon icon="play" size="dense" aria-hidden />
      Play
    </Link>
  );
}
