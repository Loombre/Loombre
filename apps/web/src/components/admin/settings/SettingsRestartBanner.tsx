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

import { AlertTriangle } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import styles from "./SettingsRestartBanner.module.css";

export function SettingsRestartBanner({ keys }: { keys: string[] }): React.JSX.Element | null {
  if (keys.length === 0) return null;
  return (
    <div className={styles.banner} role="status">
      <Icon icon={AlertTriangle} size="dense" aria-hidden />
      <div className={styles.text}>
        <div className={styles.headline}>
          Restart required to fully apply: <span className={styles.keys}>{keys.join(", ")}</span>
        </div>
        <div className={styles.caption}>SAVED NOW · OLD VALUE STAYS IN USE UNTIL RESTART · NOTHING PLAYING IS EVER INTERRUPTED</div>
      </div>
    </div>
  );
}
