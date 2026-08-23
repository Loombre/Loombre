// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/InterviewStage.tsx
//
// R8's interview: "who needs access? everyone willing to install a small
// app? need a public shareable URL? comfortable with router settings?" —
// four questions, but packages/shared's FROZEN InterviewAnswers (law) only
// carries THREE fields (everyoneWillingToInstallApp/needsPubliclyShareableUrl/
// comfortableWithRouterSettings) — "who needs access" has no decision-bearing
// field anywhere in recommendPath's pure heuristic (by design: it does not
// change which path is silent-to-scanners, third-party-free, or router-work-
// free). Rather than quietly drop the question or fabricate a field that
// influences nothing, it's asked FIRST as an honest, non-binding framing
// question — its answer only changes the wording of the question below it
// ("everyone" vs "the people you share it with"), never recommendPath's
// input. This is stated in-file rather than left for a reviewer to discover
// as a silent capability gap.

import { useState } from "react";
import { Users, User, Link2 } from "lucide-react";
import type { InterviewAnswers } from "@loombre/shared/remote";
import { ChoiceCardGroup, type ChoiceCardOption } from "./ChoiceCard.js";
import { Button } from "../../ui/Button.js";
import styles from "./InterviewStage.module.css";

type Audience = "just-me" | "trusted-few" | "anyone-with-link";

const AUDIENCE_OPTIONS: readonly ChoiceCardOption<Audience>[] = [
  { value: "just-me", label: "Just me", description: "Only your own devices need access.", icon: User },
  { value: "trusted-few", label: "A few people I trust", description: "Family, roommates, or close friends.", icon: Users },
  { value: "anyone-with-link", label: "Anyone I share a link with", description: "You want an ordinary shareable URL.", icon: Link2 },
];

const YES_NO_OPTIONS: readonly ChoiceCardOption<"yes" | "no">[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

export interface InterviewStageProps {
  onComplete: (answers: InterviewAnswers) => void;
}

export function InterviewStage({ onComplete }: InterviewStageProps): React.JSX.Element {
  const [audience, setAudience] = useState<Audience | null>(null);
  const [everyoneWillingToInstallApp, setEveryoneWillingToInstallApp] = useState<"yes" | "no" | null>(null);
  const [needsPubliclyShareableUrl, setNeedsPubliclyShareableUrl] = useState<"yes" | "no" | null>(null);
  const [comfortableWithRouterSettings, setComfortableWithRouterSettings] = useState<"yes" | "no" | null>(null);

  // browser-admin-F12: "you" takes "Are", "everyone who needs access"
  // takes "Is" — a shared noun-only `groupLabel` interpolated into one
  // fixed "Is <label> willing..." template can't agree with both, so the
  // whole verb+subject phrase is chosen per branch instead.
  const installQuestionSubject = audience === "just-me" ? "Are you" : "Is everyone who needs access";
  const canContinue = everyoneWillingToInstallApp !== null && needsPubliclyShareableUrl !== null && comfortableWithRouterSettings !== null;

  function handleContinue(): void {
    if (!canContinue) return;
    onComplete({
      everyoneWillingToInstallApp: everyoneWillingToInstallApp === "yes",
      needsPubliclyShareableUrl: needsPubliclyShareableUrl === "yes",
      comfortableWithRouterSettings: comfortableWithRouterSettings === "yes",
    });
  }

  return (
    <div className={styles.stage}>
      <h3 className={styles.title}>A few questions</h3>
      <p className={styles.subtitle}>These pick the setup that fits how you'll actually use it — nothing here is sent anywhere yet.</p>

      <ChoiceCardGroup legend="Who needs access?" options={AUDIENCE_OPTIONS} value={audience} onChange={setAudience} />

      <ChoiceCardGroup
        legend={`${installQuestionSubject} willing to install a small app (like WireGuard) on each device?`}
        options={YES_NO_OPTIONS}
        value={everyoneWillingToInstallApp}
        onChange={setEveryoneWillingToInstallApp}
      />

      <ChoiceCardGroup
        legend="Do you need a plain web link you can share, with no app required?"
        options={YES_NO_OPTIONS}
        value={needsPubliclyShareableUrl}
        onChange={setNeedsPubliclyShareableUrl}
      />

      <ChoiceCardGroup
        legend="Are you comfortable making a change in your router's settings?"
        options={YES_NO_OPTIONS}
        value={comfortableWithRouterSettings}
        onChange={setComfortableWithRouterSettings}
      />

      <div className={styles.actions}>
        <Button type="button" variant="primary" onClick={handleContinue} disabled={!canContinue}>
          See recommendation →
        </Button>
      </div>
    </div>
  );
}
