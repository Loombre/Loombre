// SPDX-License-Identifier: AGPL-3.0-only
import type { LucideIcon } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import styles from "./EmptyState.module.css";

export function EmptyState({
  icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
}): React.JSX.Element {
  return (
    <div className={styles.empty}>
      <span className={styles.iconWrap} aria-hidden="true">
        <Icon icon={icon} />
      </span>
      <p className={styles.title}>{title}</p>
      {body && <p className={styles.body}>{body}</p>}
    </div>
  );
}
