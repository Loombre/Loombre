// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/brand/BlazeMark.tsx
//
// STATE.md "Blaze logo rollout" W0 — the shared Blaze mark component
// (design/blaze/README.md "The Mark"/"Variants"/"Rules"). All geometry
// comes from ./blaze-paths.ts (the run's single path-data module, D3) —
// this file draws it, it never hardcodes a `d` string, gradient stop, or
// scanline constant of its own.
//
// D3 (one geometry, two render modes):
//   - static (default, `animated` false): ONE <path fill-rule="evenodd">
//     combining the outer + core subpaths — the core is a true hole, so
//     the mark works unmodified on any background.
//   - animated (splash/spinner, `animated` true): TWO <path> elements
//     (outer + core), core filled with the `surface` prop — the core is
//     no longer a geometric hole, it's an opaque patch matching whatever
//     backdrop it sits on, because the two independently transform in the
//     idle "blaze"/"flicker" wobble (design/blaze/assets/loombre-splash.html
//     :30 — `.rig > .blaze > (outer path, .core path)`). This component
//     renders that group structure but owns NO animation/keyframe CSS of
//     its own — Lanes B (boot splash) and C (spinner) attach their own
//     classes via the `classNames` prop (`{ rig, blaze, core }`) to
//     exactly those three slots.
//
// D5 (size gate): below BLAZE_SIZE_GATE_PX (24) rendered px, only the flat
// variant may render — gradient/scanline detail "mushes" at small sizes
// (design/blaze/README.md "Rules"). A requested gradient/scanline variant
// silently downgrades to flat and logs a dev-mode-only console.warn (never
// in production) so a caller notices the mismatch without it becoming
// user-visible console noise in a shipped build.
//
// G4: the flat fill is the brand-fixed `--brand-amber` token, never
// `--color-accent` (the user-swappable four-way accent preference) — the
// mark must not turn lime/mint/blue when someone changes their accent.
//
// Paths carry `data-mark-part` ("combined" | "outer" | "core") so tests
// (and any future consumer) can select the mark's own drawn geometry
// without ambiguity against the scanline variant's <clipPath><path>
// (clip geometry, not a rendered mark part — deliberately left untagged).
//
// Follows components/icon/Icon.tsx's aria conventions: aria-hidden by
// default (decorative), overridable with an explicit aria-label (which
// also sets role="img").

import { useId } from "react";
import {
  BLAZE_COMBINED_D,
  BLAZE_CORE_D,
  BLAZE_FLAT_FILL,
  BLAZE_GRADIENT_STOPS,
  BLAZE_GRADIENT_X1,
  BLAZE_GRADIENT_X2,
  BLAZE_GRADIENT_Y1,
  BLAZE_GRADIENT_Y2,
  BLAZE_OUTER_D,
  BLAZE_SCANLINE_OVERLAY_RECT,
  BLAZE_SCANLINE_PATTERN,
  BLAZE_VIEWBOX,
} from "./blaze-paths.js";

export type BlazeMarkVariant = "gradient" | "scanline" | "flat";

/** D5: below this rendered px, only the flat variant may render. */
export const BLAZE_SIZE_GATE_PX = 24;

/** Animation-hook class names for the rig/blaze/core structure (animated
 *  mode only) — see this file's header for what each slot is. */
export interface BlazeMarkClassNames {
  rig?: string;
  blaze?: string;
  core?: string;
}

export interface BlazeMarkProps {
  /** @default "gradient" */
  variant?: BlazeMarkVariant;
  /** Rendered size in px — drives width/height. viewBox stays fixed at
   *  "0 0 96 96" regardless. */
  size: number;
  /** D3: false (default) = one evenodd path. true = two paths (outer +
   *  surface-filled core) inside the rig/blaze animation-hook structure. */
  animated?: boolean;
  /** Animated-mode-only: the core path's fill, i.e. the surface color
   *  behind the negative-space cut-out. @default "var(--color-bg-splash)" */
  surface?: string;
  /** Animated-mode-only animation-hook classes for the rig/blaze/core
   *  groups — this component defines no keyframes itself. */
  classNames?: BlazeMarkClassNames;
  className?: string;
  "aria-hidden"?: boolean;
  "aria-label"?: string;
}

export function BlazeMark({
  variant = "gradient",
  size,
  animated = false,
  surface = "var(--color-bg-splash)",
  classNames,
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: BlazeMarkProps): React.JSX.Element {
  const gradientId = useId();
  const patternId = useId();
  const clipId = useId();

  const belowGate = size < BLAZE_SIZE_GATE_PX;
  const requestedNonFlatBelowGate = belowGate && variant !== "flat";
  const effectiveVariant: BlazeMarkVariant = belowGate ? "flat" : variant;

  if (requestedNonFlatBelowGate && process.env.NODE_ENV !== "production") {
    // Intentional dev-mode-only diagnostic (D5) — gated above, and the
    // repo's eslint config already runs with "no-console": "off".
    console.warn(
      `BlazeMark: variant="${variant}" requested at size=${size}px, below the ${BLAZE_SIZE_GATE_PX}px size gate (D5) — ` +
        `rendering "flat" instead. Gradient/scanline detail mushes below this size; see design/blaze/README.md "Rules".`,
    );
  }

  const hidden = ariaLabel === undefined ? (ariaHidden ?? true) : false;
  const a11yProps = ariaLabel !== undefined ? { "aria-label": ariaLabel, role: "img" as const } : {};

  const fill = effectiveVariant === "flat" ? BLAZE_FLAT_FILL : `url(#${gradientId})`;

  const needsGradientDef = effectiveVariant !== "flat";
  const needsScanlineDefs = effectiveVariant === "scanline";

  const mark = animated ? (
    <g className={classNames?.rig}>
      <g className={classNames?.blaze}>
        <path data-mark-part="outer" d={BLAZE_OUTER_D} fill={fill} />
        <path data-mark-part="core" className={classNames?.core} d={BLAZE_CORE_D} fill={surface} />
      </g>
    </g>
  ) : (
    <path data-mark-part="combined" fillRule="evenodd" d={BLAZE_COMBINED_D} fill={fill} />
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox={BLAZE_VIEWBOX}
      className={className}
      aria-hidden={hidden}
      {...a11yProps}
    >
      {(needsGradientDef || needsScanlineDefs) && (
        <defs>
          {needsGradientDef && (
            <linearGradient
              id={gradientId}
              x1={BLAZE_GRADIENT_X1}
              y1={BLAZE_GRADIENT_Y1}
              x2={BLAZE_GRADIENT_X2}
              y2={BLAZE_GRADIENT_Y2}
            >
              {BLAZE_GRADIENT_STOPS.map((stop) => (
                <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
              ))}
            </linearGradient>
          )}
          {needsScanlineDefs && (
            <>
              <pattern
                id={patternId}
                patternUnits="userSpaceOnUse"
                width={BLAZE_SCANLINE_PATTERN.width}
                height={BLAZE_SCANLINE_PATTERN.height}
              >
                <rect
                  width={BLAZE_SCANLINE_PATTERN.width}
                  height={BLAZE_SCANLINE_PATTERN.lineHeight}
                  fill={BLAZE_SCANLINE_PATTERN.color}
                  opacity={BLAZE_SCANLINE_PATTERN.opacity}
                />
              </pattern>
              {/* Clip geometry only — deliberately NOT data-mark-part
                  tagged (see this file's header). */}
              <clipPath id={clipId}>
                <path d={BLAZE_COMBINED_D} clipRule="evenodd" />
              </clipPath>
            </>
          )}
        </defs>
      )}
      {mark}
      {needsScanlineDefs && (
        <g clipPath={`url(#${clipId})`}>
          <rect
            x={BLAZE_SCANLINE_OVERLAY_RECT.x}
            y={BLAZE_SCANLINE_OVERLAY_RECT.y}
            width={BLAZE_SCANLINE_OVERLAY_RECT.width}
            height={BLAZE_SCANLINE_OVERLAY_RECT.height}
            fill={`url(#${patternId})`}
          />
        </g>
      )}
    </svg>
  );
}
