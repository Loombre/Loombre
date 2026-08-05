// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/RecommendationStage.tsx
//
// R8: "recommendation with honest comparison card". recommendPath (frozen,
// packages/shared's wizard-state.ts) is the ONLY thing deciding which path
// is pre-selected; the admin can still pick a different one — the
// recommendation is a default, never a lock.

import { useState } from "react";
import { Wifi, Cloud, Globe, type LucideIcon } from "lucide-react";
import { recommendPath, type InterviewAnswers, type PathId } from "@loombre/shared/remote";
import { ChoiceCardGroup, type ChoiceCardOption } from "./ChoiceCard.js";
import { ComparisonTable } from "./ComparisonTable.js";
import { Button } from "../../ui/Button.js";
import { PATH_LABELS, PATH_SHORT_DESCRIPTIONS } from "./path-labels.js";
import styles from "./RecommendationStage.module.css";

const PATH_ICONS: Record<PathId, LucideIcon> = { remote: Wifi, tunnel: Cloud, direct: Globe };

export interface RecommendationStageProps {
  answers: InterviewAnswers;
  onChoose: (path: PathId) => void;
  onBack: () => void;
}

export function RecommendationStage({ answers, onChoose, onBack }: RecommendationStageProps): React.JSX.Element {
  const recommended = recommendPath(answers);
  const [selected, setSelected] = useState<PathId>(recommended);

  const pathOptions: readonly ChoiceCardOption<PathId>[] = (["remote", "tunnel", "direct"] as const).map((path) => ({
    value: path,
    label: path === recommended ? `${PATH_LABELS[path]} (recommended)` : PATH_LABELS[path],
    description: PATH_SHORT_DESCRIPTIONS[path],
    icon: PATH_ICONS[path],
  }));

  return (
    <div className={styles.stage}>
      <h3 className={styles.title}>We recommend {PATH_LABELS[recommended]}</h3>
      <p className={styles.subtitle}>Based on your answers — pick a different path below if you'd rather.</p>

      <ChoiceCardGroup legend="Choose a path" options={pathOptions} value={selected} onChange={setSelected} />

      <ComparisonTable highlight={selected} />

      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" variant="primary" onClick={() => onChoose(selected)}>
          Continue with {PATH_LABELS[selected]} →
        </Button>
      </div>
    </div>
  );
}
