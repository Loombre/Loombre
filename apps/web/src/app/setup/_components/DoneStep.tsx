// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/setup/_components/DoneStep.tsx

import { PartyPopper } from "lucide-react";
import { Icon } from "../../../components/icon/Icon.js";
import { Button } from "../../../components/ui/Button.js";
import styles from "./steps.module.css";

export interface DoneStepProps {
  onFinish: () => void;
}

export function DoneStep({ onFinish }: DoneStepProps): React.JSX.Element {
  return (
    <div className={styles.step}>
      <div className={styles.iconBadge} aria-hidden="true">
        <Icon icon={PartyPopper} />
      </div>
      <h2 className={styles.subtitle}>You&apos;re all set</h2>
      <p className={styles.body}>
        Loombre is ready. Any library scans you started keep running in the background — check
        their progress anytime from Admin → Jobs.
      </p>
      <div className={styles.actions}>
        <Button type="button" variant="primary" onClick={onFinish}>
          Go to your library
        </Button>
      </div>
    </div>
  );
}
