// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/system/UpdateNoticeCard.tsx
//
// D-5 (Wave 2, this run — IA restructure): extracted verbatim from the
// deleted app/admin/system/page.tsx, now composed on the merged Dashboard
// (app/admin/page.tsx) instead. Same GET /system/update endpoint, same
// verification-tone rendering (a 'signature-invalid' manifest is a
// WARNING, not a hard error) — nothing about this card's behavior changed.

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { Card } from "../../ui/Card.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { describeUpdateVerification } from "../../../lib/admin-update-notice.js";
import { apiGet } from "../../../lib/api-client.js";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./system-cards.module.css";

type SystemUpdateInfo = components["schemas"]["SystemUpdateInfo"];

export function UpdateNoticeCard(): React.JSX.Element {
  const [info, setInfo] = useState<SystemUpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/system/update")
      .then(setInfo)
      .catch((err) => setError(apiErrorCopy(err, "Failed to load update status.")));
  }, []);

  return (
    <Card>
      <h2 className={styles.cardTitle}>Updates</h2>
      {error && <p className={styles.errorText}>{error}</p>}
      {!info ? (
        <Skeleton radius="md" height={80} />
      ) : (
        <>
          {(() => {
            const verification = describeUpdateVerification(info.verification);
            return (
              <div className={styles.updateBanner} data-tone={verification.tone}>
                <span className={styles.updateBannerLabel}>{verification.label}</span>
                <p className={styles.updateBannerDetail}>{verification.detail}</p>
              </div>
            );
          })()}
          <dl className={styles.factGrid}>
            <dt>Current version</dt>
            <dd>{info.currentVersion}</dd>
            <dt>Channel</dt>
            <dd>{info.channel}</dd>
            <dt>Latest known</dt>
            <dd>{info.latestVersion ?? "—"}</dd>
            <dt>Update available</dt>
            <dd>{info.updateAvailable ? "Yes" : "No"}</dd>
            <dt>Checked</dt>
            <dd>{info.checkedAtMs != null ? new Date(info.checkedAtMs).toLocaleString() : "never"}</dd>
          </dl>
          {info.notesUrl && (
            <a href={info.notesUrl} target="_blank" rel="noreferrer noopener" className={styles.notesLink}>
              Release notes
            </a>
          )}
        </>
      )}
    </Card>
  );
}
