// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/settings/SettingsRestartBanner.tsx
//
// STATE.md Addendum A, decision A5/A7 (Phosphor fidelity restyle, Wave-2
// lane L6 — design/phosphor/README.md's Advanced Server "restart-pending
// banner"): a persistent banner listing restartPendingKeys (GET
// /admin/settings) when non-empty — the server is the source of truth
// (mission spec); this component only renders whatever it's handed, it
// never computes pending-ness itself. The parent page re-fetches GET
// /admin/settings after every successful PUT, so this banner appears/
// disappears within one round trip of a requiresRestart:true change
// landing or being reverted.
//
// N6 precedence (system notices, kicked off 2026-08-04): "system notice >
// restart-pending" — one top-of-page banner class at a time. While a
// warning/critical system notice is showing (SystemNoticeProvider's
// `bannerVisible`, the SAME signal BannerRegion itself renders on), this
// component suppresses itself entirely and comes back the instant the
// notice clears — pure precedence, no change to the restartPendingKeys
// logic below.
//
// Registry reality — CORRECTED 2026-08-29 (UIFIX-2026-08-29 Lane K,
// discovery D-4 anomaly 1; supersedes the review R-F6 note of 2026-08-04
// that used to stand here). That note asserted this banner "cannot render
// from real state — lane S3's hot-reload migration deliberately left ZERO
// ui-scoped requiresRestart:true keys". That is FALSE in the current tree:
// SEVEN ui-scope keys are requiresRestart: true — remote.wireguardPort,
// remote.subnet, tls.mode, tls.acmeDomains, tls.acmeChallengeType,
// tls.acmeTosAgreed (RG12, packages/shared/src/settings-registry.ts:1085)
// and network.trustProxy — each writable via PUT /admin/settings/{key} and
// each therefore able to push its key into restartPendingKeys. The banner
// is live-reachable today. Behaviour was always correct; only the comment
// was stale.
//
// N.B. the server's rule is differs-from-BOOT-SNAPSHOT
// (packages/shared/src/settings-resolve.ts), NOT differs-from-default —
// this component still renders exactly the keys it is handed and computes
// nothing.
//
// UD-20c-adjacent (UIFIX Lane K): an OPTIONAL `actions` slot. The Advanced
// workbench supplies its own pair of controls there ("Show key", which
// selects the pending key in the table, and a confirmed "Restart now" that
// POSTs /system/restart — the operation ServerPowerCard already calls).
// Callers that pass nothing — MailSection today — keep the static
// pointer-link exactly as before, and this component still mutates nothing
// itself either way.

import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { useSystemNoticeOptional } from "../../notices/SystemNoticeProvider.js";
import styles from "./SettingsRestartBanner.module.css";

export interface SettingsRestartBannerProps {
  keys: string[];
  /** Replaces the static "Restart from Settings → Server" link when given. */
  actions?: ReactNode;
}

export function SettingsRestartBanner({ keys, actions }: SettingsRestartBannerProps): React.JSX.Element | null {
  // Optional (non-throwing): see useSystemNoticeOptional's own header —
  // this component is consumed by settings sections outside this lane's
  // file ownership, so it degrades to "no active notice" rather than
  // requiring every one of THEIR call sites to carry a provider.
  const bannerVisible = useSystemNoticeOptional()?.bannerVisible ?? false;
  if (bannerVisible || keys.length === 0) return null;
  return (
    <div className={styles.banner} role="status">
      <Icon icon={AlertTriangle} size="dense" aria-hidden />
      <div className={styles.text}>
        <div className={styles.headline}>
          Restart required to fully apply: <span className={styles.keys}>{keys.join(", ")}</span>
        </div>
        <div className={styles.caption}>SAVED NOW · OLD VALUE STAYS IN USE UNTIL RESTART · NOTHING PLAYING IS EVER INTERRUPTED</div>
        {actions !== undefined ? (
          <div className={styles.actions}>{actions}</div>
        ) : (
          /* Static pointer only — the actual action (confirm + POST
             /system/restart) lives in the Server tab's Power card; this
             banner still never computes or mutates anything itself. */
          <Link className={styles.restartLink} href="/settings/server">
            Restart from Settings → Server
          </Link>
        )}
      </div>
    </div>
  );
}
