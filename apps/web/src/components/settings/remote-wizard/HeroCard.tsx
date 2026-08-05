// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/HeroCard.tsx
//
// RemoteAccessSection's "no path active yet" entry state (mission item 1):
// a pitch card + the "Set up remote access" CTA that opens the wizard.

import { ShieldCheck } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { Card } from "../../ui/Card.js";
import { Button } from "../../ui/Button.js";
import styles from "./HeroCard.module.css";

export function HeroCard({ onStart, degraded }: { onStart: () => void; degraded: boolean }): React.JSX.Element {
  return (
    <Card>
      <div className={styles.hero}>
        <span className={styles.icon} aria-hidden="true">
          <Icon icon={ShieldCheck} />
        </span>
        <div className={styles.text}>
          <h2 className={styles.title}>Watch Loombre from anywhere</h2>
          <p className={styles.body}>
            Set up a private WireGuard network, a Cloudflare tunnel, or a direct public address — a short interview
            picks the option that fits how you'll actually use it, with an honest comparison of what each one costs
            in attack surface, third parties, and setup work.
          </p>
          {degraded && (
            <p className={styles.degradedNote}>Live status isn't available on this build yet — the wizard below still works.</p>
          )}
        </div>
        <Button type="button" variant="primary" onClick={onStart}>
          Set up remote access
        </Button>
      </div>
    </Card>
  );
}
