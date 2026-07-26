// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/PlaybackSection.tsx
//
// README tab 4 "Playback": "direct-play preference, remote quality cap,
// skip-intros." Ground-truthed (this lane's freeze report has the full
// grep): NONE of those three keys exist anywhere in
// packages/shared/src/settings-registry.ts or the contract — there is no
// per-user or server-wide "direct-play preference"/"remote quality cap"/
// "skip-intros" setting today. Per this lane's hard line (U9), the
// prototype's literal fields are NOT fabricated.
//
// What IS real and thematically the closest fit: the registry's "transcode"
// category (packages/shared/src/settings-registry.ts) — server-wide knobs
// that govern HOW the server transcodes when direct play isn't possible.
// Two "everyday" ones are surfaced inline here (README "Tabs 1–4 also
// surface their handful of everyday registry keys inline, with an
// ADVANCED → link"), reusing SettingsCategoryCard/SettingField completely
// UN-RESTYLED (those files are sibling lane L6's internals per this lane's
// scope — this component only decides WHICH entries appear on this tab,
// never how a field renders). The rest of the transcode category (and
// every other category) stays behind the Advanced Server tab.

import Link from "next/link";
import { SettingsCategoryCard } from "../../admin/settings/SettingsCategoryCard.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { useAdminSettingsData } from "./use-admin-settings-data.js";
import styles from "./PlaybackSection.module.css";

const EVERYDAY_KEYS = ["transcode.maxSimultaneousTranscodes", "transcode.hevcEncodePreferred"];

export function PlaybackSection({ heading }: { heading: string | null }): React.JSX.Element {
  const { schema, settings, error, refetch } = useAdminSettingsData();

  const entries = schema?.entries.filter((entry) => EVERYDAY_KEYS.includes(entry.key)) ?? [];
  const valuesByKey = new Map((settings?.settings ?? []).map((s) => [s.key, s] as const));

  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}
      <p className={styles.helpText}>
        No dedicated "direct-play preference" or "remote quality cap" setting exists on this build yet — the closest
        real, everyday knobs are the server&apos;s transcode settings below. Every other registry key lives under
        Advanced Server.
      </p>
      {error && <p className={styles.errorText}>{error}</p>}
      {!schema || !settings ? (
        <Skeleton radius="lg" height={160} />
      ) : entries.length > 0 ? (
        <SettingsCategoryCard category="transcode" entries={entries} valuesByKey={valuesByKey} onChanged={refetch} />
      ) : (
        <p className={styles.helpText}>No everyday keys configured on this build.</p>
      )}
      <Link href="/settings/advanced" className={styles.advancedLink}>
        Advanced Server →
      </Link>
    </div>
  );
}
