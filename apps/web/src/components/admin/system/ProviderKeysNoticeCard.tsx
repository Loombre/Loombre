// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/system/ProviderKeysNoticeCard.tsx
//
// D-5 (Wave 2, this run — IA restructure): extracted verbatim from the
// deleted app/admin/system/page.tsx, now composed on the merged Dashboard
// (app/admin/page.tsx) instead. STATE.md Addendum A decision A9/AD6:
// enrichment (posters, overviews, cast) needs at least one metadata
// provider key configured (P1.9 — a keyless scan runs fine but yields 0
// provider_ids/images). Reads the same GET /admin/settings the Plugins
// settings page itself uses (providerKeys), not a second capability
// surface — one source for "is a key set".

import { useEffect, useState } from "react";
import Link from "next/link";
import type { components } from "@loombre/sdk";
import { Card } from "../../ui/Card.js";
import { EmptyState } from "../EmptyState.js";
import { apiGet } from "../../../lib/api-client.js";
import styles from "./system-cards.module.css";
import { KeyRound } from "lucide-react";

type ProviderKeyStatus = components["schemas"]["ProviderKeyStatus"];

export function ProviderKeysNoticeCard(): React.JSX.Element | null {
  const [statuses, setStatuses] = useState<ProviderKeyStatus[] | null>(null);

  useEffect(() => {
    apiGet("/admin/settings")
      .then((res) => setStatuses(res.providerKeys))
      .catch(() => setStatuses(null));
  }, []);

  if (statuses === null) return null;
  const anySet = statuses.some((s) => s.set);
  if (anySet) return null;

  return (
    <Card>
      <h2 className={styles.cardTitle}>Metadata provider keys</h2>
      <EmptyState
        icon={KeyRound}
        title="No provider key configured"
        body="TMDB/TVDB enrichment (posters, overviews, cast) is inactive until at least one API key is set — a scan without one still completes, just with no provider metadata or images."
      />
      <Link href="/settings/plugins" className={styles.notesLink}>
        Configure provider keys
      </Link>
    </Card>
  );
}
