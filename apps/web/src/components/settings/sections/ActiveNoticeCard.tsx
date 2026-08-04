// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/ActiveNoticeCard.tsx
//
// Settings -> Notices, card (a): the currently-active system notice, or a
// calm empty state. `notice`/`loading` are both owned by the parent
// NoticesSection (single fetch of GET /system/notices' first page serves
// this card, the compose card's replace-confirm gate, AND the history
// panel — see that file's header) so this component stays a pure
// presentational + one-mutation piece.
//
// Cancel is POST /system/notices/{id}/cancel -> 204, gated behind the
// house danger-tinted confirm block (ProviderKeysCard/ServerPowerCard
// pattern). A 404 here is contractually ambiguous — "unknown id OR already
// inactive" (cancelSystemNotice's own description) — so it is deliberately
// NOT surfaced as an error: the admin's intent ("stop showing this notice")
// is already satisfied either way, so this just refreshes silently.

import { useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Card } from "../../ui/Card.js";
import { Button } from "../../ui/Button.js";
import { StatusPill } from "../../admin/StatusPill.js";
import { EmptyState } from "../../admin/EmptyState.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { apiPost, LoombreApiError } from "../../../lib/api-client.js";
import { describeNoticeSeverity, formatAbsoluteWithRelative } from "./notice-display.js";
import styles from "./NoticesSection.module.css";

type SystemNoticeAdmin = components["schemas"]["SystemNoticeAdmin"];

export function ActiveNoticeCard({
  notice,
  loading,
  onChanged,
}: {
  notice: SystemNoticeAdmin | null;
  loading: boolean;
  onChanged: () => void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A refresh can swap in a different active notice (or make it disappear
  // entirely) out from under an open confirm block — reset local state so
  // a stale confirm never lingers over the wrong (or a now-gone) notice.
  useEffect(() => {
    setConfirming(false);
    setError(null);
  }, [notice?.id]);

  async function handleCancel(): Promise<void> {
    if (!notice) return;
    setCancelling(true);
    setError(null);
    try {
      await apiPost("/system/notices/{id}/cancel", { params: { path: { id: notice.id } } });
      setConfirming(false);
      onChanged();
    } catch (err) {
      if (err instanceof LoombreApiError && err.status === 404) {
        // "Unknown id OR already inactive" — ambiguous by contract, so
        // this is treated as "already gone", not an error (this file's
        // header). Refresh so the UI catches up with reality either way.
        setConfirming(false);
        onChanged();
        return;
      }
      setError(err instanceof LoombreApiError ? err.message : "Failed to cancel notice.");
    } finally {
      setCancelling(false);
    }
  }

  const severityInfo = notice ? describeNoticeSeverity(notice.severity) : null;

  return (
    <Card>
      <h2 className={styles.cardTitle}>Active notice</h2>

      {loading ? (
        <Skeleton radius="md" height={88} />
      ) : !notice ? (
        <EmptyState
          icon={Megaphone}
          title="No active notice"
          body="Nothing is currently being shown to users on this server."
        />
      ) : (
        <div className={styles.activeBlock}>
          {severityInfo && <StatusPill label={severityInfo.label} tone={severityInfo.tone} />}

          <p className={styles.activeMessage}>{notice.message}</p>

          <dl className={styles.activeMeta}>
            {notice.effectiveAtMs !== null && (
              <div className={styles.metaRow}>
                <dt>Takes effect</dt>
                <dd>{formatAbsoluteWithRelative(notice.effectiveAtMs)}</dd>
              </div>
            )}
            <div className={styles.metaRow}>
              <dt>Expires</dt>
              <dd>{notice.expiresAtMs === null ? "Until cancelled" : formatAbsoluteWithRelative(notice.expiresAtMs)}</dd>
            </div>
          </dl>

          {error && <p className={styles.errorBanner}>{error}</p>}

          {confirming ? (
            <div className={styles.confirmBlock}>
              <span className={styles.confirmText}>Cancel this notice? Everyone stops seeing it immediately.</span>
              <div className={styles.confirmActions}>
                <Button variant="danger" onClick={() => void handleCancel()} disabled={cancelling}>
                  {cancelling ? "Cancelling…" : "Cancel notice"}
                </Button>
                <Button variant="ghost" onClick={() => setConfirming(false)} disabled={cancelling}>
                  Keep it
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => setConfirming(true)}>
                Cancel notice…
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
