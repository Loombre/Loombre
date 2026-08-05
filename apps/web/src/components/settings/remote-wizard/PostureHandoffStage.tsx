// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/PostureHandoffStage.tsx
//
// R8's final stage — "posture card handoff". Links to the posture-card
// seam (PostureCardSlot.tsx, U3's build) and ends the wizard: onFinish
// closes it and returns to RemoteAccessSection's management view, where
// the SAME slot renders again (PathManagementCard.tsx) so there is exactly
// one place the real card needs to land.

import { CheckCircle2 } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { Button } from "../../ui/Button.js";
import { PostureCardSlot } from "./PostureCardSlot.js";
import { PATH_LABELS } from "./path-labels.js";
import type { PathId } from "@loombre/shared/remote";
import styles from "./PostureHandoffStage.module.css";

export interface PostureHandoffStageProps {
  path: PathId;
  onFinish: () => void;
}

export function PostureHandoffStage({ path, onFinish }: PostureHandoffStageProps): React.JSX.Element {
  return (
    <div className={styles.stage}>
      <div className={styles.headline}>
        <span className={styles.checkIcon} aria-hidden="true">
          <Icon icon={CheckCircle2} />
        </span>
        <h3 className={styles.title}>{PATH_LABELS[path]} is set up</h3>
      </div>
      <p className={styles.subtitle}>
        You can switch paths or disable {PATH_LABELS[path]} any time from this same screen — it always reflects
        what's actually running.
      </p>

      <PostureCardSlot activePath={path} />

      <div className={styles.actions}>
        <Button type="button" variant="primary" onClick={onFinish}>
          Done — view security posture
        </Button>
      </div>
    </div>
  );
}
