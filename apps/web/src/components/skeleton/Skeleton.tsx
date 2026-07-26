// SPDX-License-Identifier: AGPL-3.0-only
import type { CSSProperties } from "react";
import styles from "./Skeleton.module.css";

export type SkeletonRadius = "pill" | "lg" | "md" | "sm" | "full";

export interface SkeletonProps {
  radius: SkeletonRadius;
  width?: string | number;
  height?: string | number;
  className?: string;
  "aria-hidden"?: boolean;
}

/**
 * Radius always inherited from the element being replaced (P2.7/P2.10) —
 * pass the SAME radius token name the real content will use. There is no
 * "default" radius on purpose: forgetting it is a compile error, not a
 * silent square-behind-a-pill bug.
 */
export function Skeleton({ radius, width, height, className, ...rest }: SkeletonProps): React.JSX.Element {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  return (
    <div
      className={[styles.skeleton, styles[radius], className].filter(Boolean).join(" ")}
      style={style}
      aria-hidden={rest["aria-hidden"] ?? true}
    />
  );
}
