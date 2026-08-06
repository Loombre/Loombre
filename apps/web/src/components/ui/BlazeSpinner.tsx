// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/ui/BlazeSpinner.tsx
//
// Shared Blaze spinner component — the mark with both idle animations at
// ~80% duration (D9). Reuses BlazeMark's animated mode (two-path with
// surface-filled core) and applies animation classes via classNames prop.
//
// D5 (size gate): below 24px rendered px, the mark downgrades to flat
// automatically (no caller awareness needed).
//
// Props:
//   - size: rendered px (16 or 48 typical; 16px will render flat per D5)
//   - surface: the color behind the core cutout (e.g., card background,
//     or the overlay behind the spinner if one exists)

import { BlazeMark } from "../brand/BlazeMark.js";
import styles from "./BlazeSpinner.module.css";

export interface BlazeSpinnerProps {
  /** Rendered size in px. Below 24px automatically downgrades to flat per D5. */
  size: number;
  /** Core cutout fill color — typically the surface behind the spinner.
   *  @default "var(--color-bg-splash)" */
  surface?: string | undefined;
  /** Optional additional className for the <svg> container. */
  className?: string | undefined;
  /** aria-label for the spinner; absence makes it aria-hidden. */
  "aria-label"?: string | undefined;
}

export function BlazeSpinner({
  size,
  surface = "var(--color-bg-splash)",
  className = undefined,
  "aria-label": ariaLabel = undefined,
}: BlazeSpinnerProps): React.JSX.Element {
  const props: React.ComponentProps<typeof BlazeMark> = {
    size,
    variant: "gradient",
    animated: true,
    surface,
    classNames: {
      rig: styles.rig as string,
      blaze: styles.blaze as string,
      core: styles.core as string,
    },
  };

  if (className !== undefined) props.className = className;
  if (ariaLabel !== undefined) props["aria-label"] = ariaLabel;

  return <BlazeMark {...props} />;
}
