// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/watchlist/WatchlistPosterCard.tsx
//
// Phosphor Wave 2 lane L3 — the poster tile design/phosphor README.md's
// Watchlist screen ("poster grid of saved titles, inline REMOVE on cards")
// and Home's "Your Watchlist" rail ("each card offering inline REMOVE")
// BOTH use — one component, two hosts (a plain CSS grid on /watchlist, a
// horizontal Row on Home), matching this codebase's existing
// PosterCard/PosterCell split: this is the PosterCell shape (a real
// clickable `<a>`, view-transition on navigate) with an added inline REMOVE
// overlay button whose click is stopped from also triggering the card's
// own navigation.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import { buildImageSrcSet, buildImageUrl, defaultImageSizes } from "../../lib/image-url.js";
import { posterTransitionName, runViewTransition } from "../../lib/view-transition.js";
import styles from "./WatchlistPosterCard.module.css";

export interface WatchlistPosterCardProps {
  serverUrl: string;
  accessToken: string;
  entityType: string;
  entityId: string;
  href: string;
  title: string;
  subtitle?: string | undefined;
  blurhash: string | null;
  /** browser-casual-F4: whether the item's own `images` payload declares a
   *  "poster" entry at all. Defaults to `true` (old behavior — always
   *  attempt the fetch) for callers that haven't been threaded through
   *  yet. `false` skips the network `<img>` outright instead of firing a
   *  request this component already knows is doomed — see
   *  components/browse/PosterCell.tsx's identical prop of the same name
   *  (this file's header already calls this "the PosterCell shape"). */
  hasPoster?: boolean | undefined;
  /** Runs the actual DELETE /watchlist/{itemId} + local-state update; this
   *  component only owns the button's own pending/disabled affordance
   *  while it awaits. */
  onRemove: () => Promise<void>;
}

export function WatchlistPosterCard({
  serverUrl,
  accessToken,
  entityType,
  entityId,
  href,
  title,
  subtitle,
  blurhash,
  hasPoster = true,
  onRemove,
}: WatchlistPosterCardProps): React.JSX.Element {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [removing, setRemoving] = useState(false);
  const placeholderUri = useMemo(() => (blurhash ? blurhashToDataUri(blurhash) : null), [blurhash]);

  const src = buildImageUrl({ serverUrl, accessToken, entityType, entityId, kind: "poster", width: 320 });
  const srcSet = buildImageSrcSet({ serverUrl, accessToken, entityType, entityId, kind: "poster" });

  function handleClick(event: React.MouseEvent<HTMLAnchorElement>): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    runViewTransition(() => router.push(href));
  }

  async function handleRemoveClick(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (removing) return;
    setRemoving(true);
    try {
      await onRemove();
    } catch {
      // Best-effort: leave the card in place on failure (no dedicated error
      // copy specified by the prototype) — the REMOVE control just stays
      // clickable again for a retry.
      setRemoving(false);
    }
  }

  return (
    <a
      href={href}
      className={styles.tile}
      onClick={handleClick}
      aria-label={subtitle ? `${title}, ${subtitle}` : title}
    >
      <div className={styles.imageWrap} style={{ viewTransitionName: posterTransitionName(entityId) }}>
        {placeholderUri && (
          <img className={styles.placeholder} data-loaded={loaded} src={placeholderUri} alt="" aria-hidden="true" />
        )}
        {hasPoster && (
          <img
            className={styles.image}
            data-loaded={loaded}
            src={src}
            srcSet={srcSet}
            sizes={defaultImageSizes()}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
          />
        )}
        <button
          type="button"
          className={styles.removeButton}
          onClick={(e) => void handleRemoveClick(e)}
          disabled={removing}
          aria-label={`Remove ${title} from watchlist`}
        >
          <Icon icon={X} size="dense" aria-hidden />
        </button>
        {/* S7 poster signature: in-artwork title, additional to the
            below-caption title span below (dc renders both). */}
        <span className={styles.artTitle} aria-hidden="true">
          {title}
        </span>
      </div>
      <span className={styles.title}>{title}</span>
      {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
    </a>
  );
}
