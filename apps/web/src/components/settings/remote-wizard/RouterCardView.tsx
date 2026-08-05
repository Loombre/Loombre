// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/RouterCardView.tsx
//
// STATE.md "Loombre Remote ..." (R5, Lane U2): the ONE renderer for
// packages/shared/src/remote/router-cards.ts's RouterCard shape (D1's
// content module, header: "the web wizard (U-lane) renders, and the docs
// generator (DOC lane, R10) consumes for the SAME reference content").
// Three call sites share this instead of three copies:
//   - Remote path's "remote-enable" step (UDP port-forward, R2/R3)
//   - Direct path's "direct-router-instructions" step (TCP 80/443, R5)
//   - ProofStage's failed-reachability WAN-address card (RG11)
//
// A brand picker (ChoiceCardGroup over RouterBrandId) plus the card body
// itself (title/intro/ordered steps/a described diagram placeholder — this
// module carries no images, router-cards.ts's own header: "a described
// placeholder for an illustrative screenshot/diagram"). Content-only (R9,
// router-cards.ts's own hard line): renders text, calls nothing, touches
// no network settings.

import { ROUTER_BRAND_IDS, ROUTER_BRAND_LABELS, type RouterBrandId, type RouterCard } from "@loombre/shared/remote";
import { ChoiceCardGroup, type ChoiceCardOption } from "./ChoiceCard.js";
import styles from "./RouterCardView.module.css";

const BRAND_OPTIONS: readonly ChoiceCardOption<RouterBrandId>[] = ROUTER_BRAND_IDS.map((id) => ({
  value: id,
  label: ROUTER_BRAND_LABELS[id],
}));

export function RouterBrandPicker({
  value,
  onChange,
  legend = "What's your router?",
}: {
  value: RouterBrandId;
  onChange: (brand: RouterBrandId) => void;
  legend?: string;
}): React.JSX.Element {
  return <ChoiceCardGroup legend={legend} options={BRAND_OPTIONS} value={value} onChange={onChange} />;
}

export function RouterCardPanel({ card }: { card: RouterCard }): React.JSX.Element {
  return (
    <div className={styles.panel}>
      <p className={styles.title}>{card.title}</p>
      <p className={styles.intro}>{card.intro}</p>
      <ol className={styles.steps}>
        {card.steps.map((step, i) => (
          <li key={step.heading} className={styles.step}>
            <span className={styles.stepIndex}>{i + 1}</span>
            <span className={styles.stepBody}>
              <span className={styles.stepHeading}>{step.heading}</span>
              <span className={styles.stepText}>{step.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className={styles.diagram} role="img" aria-label={card.diagram.description}>
        <span className={styles.diagramLabel}>{card.diagram.label}</span>
        <span className={styles.diagramCaption}>{card.diagram.description}</span>
      </div>
    </div>
  );
}
