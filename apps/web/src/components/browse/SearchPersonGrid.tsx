// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/browse/SearchPersonGrid.tsx
//
// Phosphor H5 search retheme (design/phosphor/dc:352-362, "PEOPLE"): 64px
// avatar + name + roles. Uses the SHARED components/ui/Card.js Avatar
// (another Wave-3 lane is adding per-user hues to that one component —
// this just consumes it, no local reimplementation).
//
// Ground truth for the second line: the prototype fixture is `p.roles`
// ("Actor · Director"-style). GET /people (packages/contract/openapi.yaml
// `Person` schema) carries only `{id, name, contentClass, creditCount}` —
// no role/credit-type breakdown at all, only an aggregate visible-item
// count (packages/db/src/query/people.ts's header: "creditCount is
// DISTINCT items visible to the caller this person is credited on"). A
// role list would have to be invented; the real, honest substitute is that
// same creditCount, phrased as "N credits" — still real data on the same
// line the fixture reserved for a person fact, never a fabricated role
// label.

import Link from "next/link";
import type { components } from "@loombre/sdk";
import { Avatar } from "../ui/Card.js";
import styles from "./SearchPersonGrid.module.css";

type Person = components["schemas"]["Person"];

function creditLabel(person: Person): string {
  return `${person.creditCount} credit${person.creditCount === 1 ? "" : "s"}`;
}

export function SearchPersonGrid({ people, activeId }: { people: Person[]; activeId?: string | undefined }): React.JSX.Element {
  return (
    <div className={styles.grid} role="list">
      {people.map((person) => (
        <Link
          key={person.id}
          href={`/people/${person.id}`}
          className={styles.tile}
          role="listitem"
          data-search-id={person.id}
          data-search-active={person.id === activeId}
        >
          <Avatar label={person.name} size={64} />
          <span className={styles.name}>{person.name}</span>
          <span className={styles.roles}>{creditLabel(person)}</span>
        </Link>
      ))}
    </div>
  );
}
