// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/MailSection.tsx
//
// Optional Mail Transport run (STATE.md E5-E9/M8-M11): the tab-slot this
// lane owns, composing three real surfaces —
//   (a) the schema-driven registry fields for mail.smtpHost/smtpPort/
//       smtpSecurity/fromAddress/fromName + network.publicUrl, via the
//       SAME useAdminSettingsData()/SettingsCategoryCard/SettingField
//       renderer every other registry-backed tab uses (task spec: "do NOT
//       fork the renderer") — env-pin locked states, validation, and
//       restart-pending banners all come along for free because nothing
//       here reimplements them.
//   (b) MailCredentialsCard — write-only SMTP username/password.
//   (c) MailTestSendCard — "to" input, real end-to-end send, live outcome.
//
// (d) E1 posture intro line, register-appropriate (E9: admin guide teaches
// the copy-link/CLI-reset path FIRST, mail as the upgrade) — this section
// is reached only by an admin who already opted into configuring mail; the
// line exists so the same truth is visible right here too, not just in
// docs: nothing below is required for invites or recovery to work.

import { SettingsRestartBanner } from "../../admin/settings/SettingsRestartBanner.js";
import { SettingsCategoryCard } from "../../admin/settings/SettingsCategoryCard.js";
import { MailCredentialsCard } from "../../admin/settings/MailCredentialsCard.js";
import { MailTestSendCard } from "../../admin/settings/MailTestSendCard.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { Button } from "../../ui/Button.js";
import { useAdminSettingsData } from "./use-admin-settings-data.js";
import styles from "./MailSection.module.css";

/** The five mail.* registry keys (M10) plus network.publicUrl (M9) — every
 *  other registry entry is out of scope for this tab even though
 *  network.publicUrl technically lives in the "network" category; it's
 *  included here because EVERY mail link/test-send depends on it, and
 *  making an admin hunt for it on the Advanced tab to finish configuring
 *  mail would be the same kind of gap this run's E1 posture exists to
 *  avoid. */
function isMailEntry(key: string): boolean {
  return key.startsWith("mail.") || key === "network.publicUrl";
}

export function MailSection({ heading }: { heading: string | null }): React.JSX.Element {
  const { schema, settings, error, refetch, retry } = useAdminSettingsData();

  // AUD-A3b-002: a fetch failure keeps the page shell (heading intact, like
  // every sibling consumer of this hook) and offers a real retry instead of
  // blanking the whole tab behind a bare, terminal error line.
  if (error) {
    return (
      <div className={styles.page}>
        {heading !== null && <h1 className={styles.heading}>{heading}</h1>}
        <p className={styles.errorBanner} role="alert">
          {error}
        </p>
        <div className={styles.errorActions}>
          <Button type="button" variant="secondary" onClick={retry}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!schema || !settings) {
    return (
      <div className={styles.page}>
        {heading !== null && <h1 className={styles.heading}>{heading}</h1>}
        <div className={styles.skeletonList} aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} radius="lg" height={140} />
          ))}
        </div>
      </div>
    );
  }

  const mailEntries = schema.entries.filter((e) => isMailEntry(e.key));
  const valuesByKey = new Map(settings.settings.map((s) => [s.key, s] as const));
  // Additive field (M10) — an older cached AdminSettingsResponse shape (or
  // a not-yet-refetched one right after this section first mounts) could
  // in principle omit it; a synthetic "never configured, no source" status
  // keeps MailCredentialsCard's props honest rather than making the field
  // optional there too.
  const mailCredentials = settings.mailCredentials ?? { configured: false, setAtMs: null, source: null };

  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}

      <p className={styles.intro}>
        Mail is optional (E1) — invites are copyable one-time links and password recovery has an admin/CLI path
        whether or not anything below is configured. Configuring mail simply DELIVERS those same links by email
        instead of you having to copy and send them yourself.
      </p>

      <SettingsRestartBanner keys={settings.restartPendingKeys.filter((k) => isMailEntry(k))} />

      <SettingsCategoryCard
        category="mail"
        entries={mailEntries}
        valuesByKey={valuesByKey}
        onChanged={refetch}
        titleOverride="Mail transport"
        metaOverride={`${mailEntries.length} keys`}
      />

      <MailCredentialsCard status={mailCredentials} onChanged={refetch} />

      <MailTestSendCard settings={settings} />
    </div>
  );
}
