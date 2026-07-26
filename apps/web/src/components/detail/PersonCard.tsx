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

export function PersonCard({ person }: { person: PersonCredit }): React.JSX.Element {
  return (
    <Link href={`/people/${person.id}`} className={styles.card}>
      <Avatar label={person.name} size={64} />
      <span className={styles.name}>{person.name}</span>
      <span className={styles.role}>{person.credit ?? ROLE_LABEL[person.role]}</span>
    </Link>
  );
}
