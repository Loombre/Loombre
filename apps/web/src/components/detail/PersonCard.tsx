// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/PersonCard.tsx
//
// P2 work item 4: one credited person inside a detail page's people row
// (avatar-circle initials fallback via the shared ui/Card.js Avatar, role
// caption). NOW a link (Phosphor Wave 2 lane L3): design/phosphor
// README.md's "Navigation" rule — "Cast opens Person" — and /people/[id]
// exists as of this lane. Previously deliberately NOT a link (no route to
// send it to, same gap components/browse/SearchPanel.tsx's own person
// chips called out); that gap is closed, so this component and
// SearchPanel's chips both link now.

import Link from "next/link";
import type { components } from "@loombre/sdk";
import { Avatar } from "../ui/Card.js";
import { buildImageUrl } from "../../lib/image-url.js";
import styles from "./PersonCard.module.css";

type PersonCredit = components["schemas"]["PersonCredit"];

const ROLE_LABEL: Record<PersonCredit["role"], string> = {
  actor: "Actor",
  director: "Director",
  writer: "Writer",
  artist: "Artist",
  album_artist: "Album Artist",
  performer: "Performer",
  guest: "Guest",
};

export interface PersonCardProps {
  person: PersonCredit;
  /** Needed to build the portrait URL (GET /images/person/{id}/thumb is a
   *  token-in-query image route like every other managed image). Callers
   *  that render credits without a session (none today) may omit both —
   *  the card then always shows the initials avatar. */
  serverUrl?: string;
  accessToken?: string | null;
}

/** True when the credit carries an ingested `thumb` portrait — the ONLY
 *  case an <img> is rendered. `images` is the server's own statement of
 *  what exists, so an unmatched person never costs a 404 round-trip. */
export function hasPortrait(person: PersonCredit): boolean {
  return (person.images ?? []).some((img) => img.kind === "thumb");
}

export function PersonCard({ person, serverUrl, accessToken }: PersonCardProps): React.JSX.Element {
  const portrait = serverUrl && accessToken && hasPortrait(person);
  return (
    <Link href={`/people/${person.id}`} className={styles.card}>
      {portrait ? (
        <img
          className={styles.portrait}
          src={buildImageUrl({ serverUrl, accessToken, entityType: "person", entityId: person.id, kind: "thumb", width: 192 })}
          alt=""
          width={64}
          height={64}
          loading="lazy"
        />
      ) : (
        <Avatar label={person.name} size={64} />
      )}
      <span className={styles.name}>{person.name}</span>
      <span className={styles.role}>{person.credit ?? ROLE_LABEL[person.role]}</span>
    </Link>
  );
}
