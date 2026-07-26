// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/AdvancedSection.tsx
//
// README tab 7 "Advanced Server": the schema-driven registry. This file is
// the TAB SLOT lane L1 owns; the components it mounts are lane L6's
// internals. Reconciled at Wave-2 landing (orchestrator): L6 shipped the
// registry filter field + category pills (RegistryFilterBar) and the
// one-category-at-a-time behavior against the pre-IA /admin/settings page,
// which L1 had meanwhile turned into a redirect stub — that page-level
// wiring now lives HERE, verbatim in semantics: a live query OVERRIDES
// category scoping rather than combining with it, and clearing the query
// reverts to whichever category was last selected (never resets to the
// first one). This component owns that selection state because it's the
// thing both RegistryFilterBar's pills AND SettingsCategoryCard's single
// visible section need to agree on.

import { useState } from "react";
import { SettingsRestartBanner } from "../../admin/settings/SettingsRestartBanner.js";
import { RegistryFilterBar } from "../../admin/settings/RegistryFilterBar.js";
import { CATEGORY_LABELS, SettingsCategoryCard } from "../../admin/settings/SettingsCategoryCard.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { categorySummaries, filterEntriesByQuery, groupByCategory } from "../../../lib/settings-schema-widget.js";
import { useAdminSettingsData } from "./use-admin-settings-data.js";
import styles from "./AdvancedSection.module.css";

export function AdvancedSection({ heading }: { heading: string | null }): React.JSX.Element {
  const { schema, settings, error, refetch } = useAdminSettingsData();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  if (error) {
    return <p className={styles.errorBanner}>{error}</p>;
  }

  if (!schema || !settings) {
    return (
      <div className={styles.page}>
        {heading !== null && <h1 className={styles.heading}>{heading}</h1>}
        <div className={styles.skeletonList} aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} radius="lg" height={160} />
          ))}
        </div>
      </div>
    );
  }

  const valuesByKey = new Map(settings.settings.map((s) => [s.key, s] as const));
  const groups = groupByCategory(schema.entries);
  const categories = categorySummaries(schema.entries);
  const defaultCategory = groups[0]?.category ?? null;
  const activeCategory = category ?? defaultCategory;
  const trimmedQuery = query.trim();
  const editableCount = schema.entries.filter((e) => e.scope === "ui").length;
  const envOnlyCount = schema.entries.length - editableCount;

  const visibleEntries = trimmedQuery
    ? filterEntriesByQuery(schema.entries, trimmedQuery)
    : (groups.find((g) => g.category === activeCategory)?.entries ?? []);

  // exactOptionalPropertyTypes (tsconfig.base.json): these overrides are
  // spread in only while filtering IS active — never assigned `undefined`
  // explicitly, which that flag treats as distinct from "prop absent".
  const filteredViewProps = trimmedQuery
    ? {
        titleOverride: "Filter results",
        metaOverride: `${visibleEntries.length} of ${schema.entries.length} advanced keys match`,
        emptyMessage: `No key matches “${trimmedQuery}”.`,
      }
    : {};

  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}
      <div className={styles.registrySection}>
        <div className={styles.registryHeader}>
          <h2 className={styles.registryTitle}>Advanced server settings</h2>
          <span className={styles.registryMeta}>
            {schema.entries.length} REGISTRY KEYS · {editableCount} EDITABLE · {envOnlyCount} ENV-ONLY
          </span>
        </div>

        <RegistryFilterBar
          categories={categories}
          categoryLabels={CATEGORY_LABELS}
          activeCategory={activeCategory}
          onSelectCategory={setCategory}
          query={query}
          onQueryChange={setQuery}
        />

        <SettingsRestartBanner keys={settings.restartPendingKeys} />

        {activeCategory !== null && (
          <SettingsCategoryCard
            category={activeCategory}
            entries={visibleEntries}
            valuesByKey={valuesByKey}
            onChanged={refetch}
            {...filteredViewProps}
          />
        )}
      </div>
    </div>
  );
}
