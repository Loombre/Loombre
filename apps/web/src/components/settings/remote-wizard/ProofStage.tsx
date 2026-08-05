// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/ProofStage.tsx
//
// R6's reachability proof — mission scope for this lane is explicitly
// "placeholder slot for U2" (this file's whole body), same posture as
// PathFlowStage's step bodies: no QR library exists yet (RG8 — "U2
// selects, records provenance if vendored") and P1's probe-token endpoints
// are still 501 shells on this lane's base, so this renders the STRUCTURE
// (what a real proof screen needs: a scannable code, a live status, a
// fallback path) without fabricating a working QR or a live poll against
// endpoints this lane never calls.

import { Smartphone } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { Button } from "../../ui/Button.js";
import { PATH_LABELS } from "./path-labels.js";
import type { PathId } from "@loombre/shared/remote";
import styles from "./ProofStage.module.css";

export interface ProofStageProps {
  path: PathId;
  onComplete: () => void;
  onBack: () => void;
}

export function ProofStage({ path, onComplete, onBack }: ProofStageProps): React.JSX.Element {
  return (
    <div className={styles.stage}>
      <h3 className={styles.title}>Prove {PATH_LABELS[path]} actually reaches you</h3>
      <p className={styles.subtitle}>
        Scan this code with a phone on <strong>cellular data</strong>, not your home Wi-Fi — the phone is the real
        outside test, not a third-party checking service.
      </p>

      <div className={styles.qrRow}>
        <div className={styles.qrPlaceholder} aria-hidden="true">
          <Icon icon={Smartphone} size="dense" />
        </div>
        <div className={styles.qrText}>
          <p className={styles.qrLabel}>Live QR code and reachability check</p>
          <p className={styles.qrNote}>
            This lands in a follow-up pass, once probe minting and polling are wired up here. Use Continue below to
            keep exploring the rest of the wizard.
          </p>
        </div>
      </div>

      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" variant="primary" onClick={onComplete}>
          Continue →
        </Button>
      </div>
    </div>
  );
}
