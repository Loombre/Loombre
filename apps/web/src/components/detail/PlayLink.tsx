// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/detail/PlayLink.tsx
//
// Just a link to lane (ii)'s player route — this lane does not build the
// player itself (file ownership: app/watch/** belongs to lane (ii)).
//
// It MUST be a next/link, never a raw <a href> (QA browser-items-F1):
// app/watch/[itemId]/page.tsx's audio branch hands the track to the
// MusicPlayerProvider mounted ABOVE the route (AppProviders) and then
// navigates on to the item's own page. A raw anchor makes that a
// cross-document trip — the provider that receives playTrack() belongs to
// the throwaway /watch document and dies with it, so the user arrives at
// an empty queue with no MiniPlayerBar and no error. Client-side
// navigation keeps one document (and one provider) across the whole
// handoff, and is also what makes /watch's React unmount path real for the
// video branch. Guarded by PlayLink.test.tsx.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "../icon/Icon.js";
import styles from "./PlayLink.module.css";

/** The pages /watch's AUDIO branch lands on after the handoff (that route's
 *  `router.replace(`/items/${kind}/${id}`)`). */
function watchReturnsToThisPage(pathname: string | null, itemId: string): boolean {
  return pathname === `/items/track/${itemId}` || pathname === `/items/album/${itemId}`;
}

export function PlayLink({ itemId }: { itemId: string }): React.JSX.Element {
  const pathname = usePathname();

  // QA verify/gap-F8 (P3), the dead Back entry: for a TRACK or ALBUM, /watch
  // is a transient handoff — it hands the item to the persistent music player
  // and immediately router.replace()s to /items/{kind}/{id}, which is the
  // page this link was clicked on. Pushing /watch first therefore leaves two
  // adjacent history entries for the SAME url, and the viewer's next Back
  // does nothing visible. Replacing collapses the round trip to nothing.
  //
  // Derived from where the link is RENDERED rather than from a caller-passed
  // kind on purpose: the condition that matters is "the handoff will land
  // back on this exact page", which is a fact about this page, and every
  // audio Play affordance in the app is rendered on the item's own detail
  // page. Video must keep the push — /watch STAYS mounted there and the
  // player's own Back is a history traversal home to the detail page.
  const replace = watchReturnsToThisPage(pathname, itemId);

  return (
    <Link href={`/watch/${itemId}`} replace={replace} className={styles.button}>
      <Icon icon="play" size="dense" aria-hidden />
      Play
    </Link>
  );
}
