// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/DirectRouterInstructionsStepBody.tsx
//
// STATE.md "Loombre Remote ..." (R5, Lane U2's mission item 4) — the
// Direct path's LAST step, "direct-router-instructions" (packages/shared's
// frozen PATH_FLOW_STEPS.direct[3], reached by both the acme and
// reverse-proxy branches — router-level exposure is needed either way).
// Two port-forward cards (router-cards.ts's own PortForwardParams shape,
// D1's content): TCP 80 (the ACME http-01 challenge port AND the
// plain-HTTP-to-HTTPS redirect target, apps/server/src/tls/acme/
// http01-server.ts's own header) and TCP 443 (real HTTPS traffic).
// Content-only — this step calls no API; R6's proof stage is the actual
// verification.

import { useState } from "react";
import { buildPortForwardCard, type RouterBrandId } from "@loombre/shared/remote";
import { Button } from "../../ui/Button.js";
import { RouterBrandPicker, RouterCardPanel } from "./RouterCardView.js";
import type { PathFlowStepBodyProps } from "./path-flow-step-types.js";
import styles from "./DirectRouterInstructionsStepBody.module.css";

const HTTP_PORT = 80;
const HTTPS_PORT = 443;

export function DirectRouterInstructionsStepBody({ onStepComplete, onBack }: PathFlowStepBodyProps): React.JSX.Element {
  const [brand, setBrand] = useState<RouterBrandId>("generic");

  return (
    <div className={styles.step}>
      <p className={styles.stepTitle}>Forward a port on your router</p>
      <p className={styles.body}>
        For Direct access to work from outside your home network, your router needs to forward two ports to this
        server: 80 (used only to prove you own the domain, and to redirect plain HTTP to HTTPS) and 443 (real
        traffic).
      </p>

      <RouterBrandPicker value={brand} onChange={setBrand} />

      <RouterCardPanel card={buildPortForwardCard(brand, { protocol: "tcp", externalPort: HTTP_PORT, internalPort: HTTP_PORT })} />
      <RouterCardPanel card={buildPortForwardCard(brand, { protocol: "tcp", externalPort: HTTPS_PORT, internalPort: HTTPS_PORT })} />

      <div className={styles.stepActions}>
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        <Button type="button" variant="primary" onClick={() => onStepComplete()}>
          Continue
        </Button>
      </div>
    </div>
  );
}
