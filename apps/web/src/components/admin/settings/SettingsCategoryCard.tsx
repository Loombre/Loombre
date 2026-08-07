// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/settings/SettingsCategoryCard.tsx
//
// STATE.md Addendum A, decision A7 (lane S2) + Phosphor Wave-2 lane L6
// (prototype fidelity restyle): one registry category's section — a header
// (category label + derived key count + "reset category to default") and
// its entries, each rendered by SettingField. Category grouping/order comes
// from lib/settings-schema-widget.ts#groupByCategory (registry order, not
// alphabetized) — this component only renders a group it's handed, it
// doesn't compute the grouping itself.
//
// Phosphor fidelity note (design/phosphor/README.md's Advanced Server card):
// the prototype gives the WHOLE category ONE bordered/translucent-fill box
// (border-radius:14px, background rgba(255,255,255,.015)) with individual
// keys separated by a plain top hairline — it does NOT box every key
// separately on desktop. This component reproduces that: SettingsCategoryCard
// owns the shared box + inter-field hairlines (.module.css's `.list > * + *`
// rule — a stable selector that never needs to know SettingField's own
// (module-hashed) class name); SettingField itself renders borderless at
// desktop widths and only grows its own border/radius/fill box at the
// mobile breakpoint, where the prototype DOES box each key individually
// (see SettingField.module.css's own header for that half of the split).
//
// Reused for BOTH the single-category view and the "Filter results"
// cross-category view (titleOverride/metaOverride) — the prototype's own
// regResetCat button is generic over "whatever's currently listed" for the
// exact same reason, so no separate component exists for the filtered case.

"use client";

import { useState } from "react";
import { Icon } from "../../icon/Icon.js";
import { Button } from "../../ui/Button.js";
import { SettingField } from "./SettingField.js";
import { isAtDefault, isEditable } from "../../../lib/settings-schema-widget.js";
import { apiPut, LoombreApiError } from "../../../lib/api-client.js";
import type { components } from "@loombre/sdk";
import styles from "./SettingsCategoryCard.module.css";

type AdminSettingSchemaEntry = components["schemas"]["AdminSettingSchemaEntry"];
type AdminSettingValue = components["schemas"]["AdminSettingValue"];

/** Human labels for the closed SettingsCategory enum (packages/shared/src/
 *  settings-registry.ts's own category list) — presentation only, kept
 *  here rather than in the pure lib module since it's UI copy, not a
 *  decision rule; falls back to the raw category string for a category
 *  this map hasn't been updated for yet (never blocks rendering). Exported
 *  so RegistryFilterBar's category pills and this card's own header always
 *  read the SAME label for a given category — never a second copy. */
export const CATEGORY_LABELS: Record<string, string> = {
  transcode: "Transcode",
  scanner: "Scanner",
  images: "Images",
  restricted: "Restricted content",
  sessions: "Sessions",
  updateCheck: "Update check",
  security: "Security",
  rateLimit: "Rate limits",
  database: "Database",
  network: "Network",
  tls: "TLS",
  paths: "Paths",
  ffmpeg: "ffmpeg",
  mail: "Mail",
  remote: "Remote access",
  // W3-R (opus review): 'stash' was missing, so the Advanced Server
  // filter chip and card header rendered the raw lowercase slug.
  stash: "Stash",
};

export interface SettingsCategoryCardProps {
  category: string;
  entries: AdminSettingSchemaEntry[];
  valuesByKey: Map<string, AdminSettingValue>;
  /** Called once after ANY successful write in this card (a single field
   *  save, or a category reset) — the parent does one GET /admin/settings
   *  refetch (mission spec: "re-fetch after every successful PUT"), so
   *  every field here always renders the server's own authoritative state,
   *  never a locally-guessed one. */
  onChanged: () => void;
  /** Set by the parent when a registry filter query is active (the
   *  "Filter results" cross-category view) — replaces the category label
   *  derived from CATEGORY_LABELS. */
  titleOverride?: string;
  /** Set alongside titleOverride — a match-count readout instead of the
   *  plain "N keys" meta this card computes for a single category. */
  metaOverride?: string;
  /** Shown instead of the field list when `entries` is empty — the
   *  prototype's "NO KEY MATCHES" state, generalized for any empty result
   *  (a category with a query that matched nothing here). */
  emptyMessage?: string;
}

export function SettingsCategoryCard({
  category,
  entries,
  valuesByKey,
  onChanged,
  titleOverride,
  metaOverride,
  emptyMessage,
}: SettingsCategoryCardProps): React.JSX.Element {
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resettable = entries.filter((entry) => {
    if (!isEditable(entry)) return false;
    const effective = valuesByKey.get(entry.key);
    return effective !== undefined && !isAtDefault(effective.value, entry.default);
  });

  async function handleResetCategory(): Promise<void> {
    setResetting(true);
    setError(null);
    try {
      for (const entry of resettable) {
        // Sequential, not Promise.all: A10 live-admin re-verify + the
        // outbox write both hit the same actor row per key — there is no
        // benefit to racing several PUTs against one admin's settings, and
        // sequential keeps a partial-failure's error message attributable
        // to a specific key rather than an ambiguous aggregate.
        await apiPut("/admin/settings/{key}", { params: { path: { key: entry.key } }, body: { value: entry.default } });
      }
      onChanged();
    } catch (err) {
      setError(err instanceof LoombreApiError ? err.message : "Failed to reset one or more settings in this category.");
    } finally {
      setResetting(false);
    }
  }

  const title = titleOverride ?? (CATEGORY_LABELS[category] ?? category);
  const meta = metaOverride ?? `${entries.length} ${entries.length === 1 ? "key" : "keys"}`;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        <span className={styles.meta}>{meta}</span>
        {resettable.length > 0 && (
          <Button
            variant="ghost"
            className={styles.resetCategory}
            onClick={() => void handleResetCategory()}
            disabled={resetting}
          >
            <Icon icon="reset" size="dense" />
            Reset category
          </Button>
        )}
      </div>
      {error && <p className={styles.errorText}>{error}</p>}
      {entries.length === 0 ? (
        <p className={styles.empty}>{emptyMessage ?? "No keys in this category."}</p>
      ) : (
        <div className={styles.list}>
          {entries.map((entry) => {
            const effective = valuesByKey.get(entry.key);
            if (!effective) return null;
            // W13b (D-7's copy sweep): the registry's own additive
            // technicalDetails field, straight through to SettingField's
            // info tooltip — spread conditionally (not
            // technicalDetails={entry.technicalDetails}) because
            // exactOptionalPropertyTypes forbids assigning an explicit
            // `undefined` to a prop typed `string | undefined`; an entry
            // with no technicalDetails simply omits the prop, which
            // SettingField already treats as "no caller-supplied note" (it
            // still shows a trigger on its own for a pinnable entry via its
            // env-pin note).
            return (
              <SettingField
                key={entry.key}
                entry={entry}
                value={effective.value}
                source={effective.source}
                onChanged={onChanged}
                {...(entry.technicalDetails !== undefined ? { technicalDetails: entry.technicalDetails } : {})}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
