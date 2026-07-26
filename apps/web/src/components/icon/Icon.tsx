// SPDX-License-Identifier: AGPL-3.0-only
import type { LucideIcon } from "lucide-react";
import { PHOSPHOR_ICONS, type PhosphorIconName } from "./phosphor-paths.js";

/**
 * Structural Lucide compliance (STATE.md P2.9): every icon in the app must
 * render through this wrapper so stroke width (1.75), cap/join style
 * (round), and the 24px/20px grid are set ONCE, not re-specified at every
 * call site. A second icon set (or a raw `<svg>`) bypassing this wrapper
 * is a review failure — grep for `from "lucide-react"` outside this file
 * plus call sites importing `Icon` to audit compliance.
 *
 * Import icons as tree-shaken named imports from "lucide-react" and pass
 * the component in via `icon`, e.g. `<Icon icon={Home} />`.
 *
 * U7 (STATE.md, Wave 2 lane L7): `icon` also accepts a PhosphorIconName —
 * a string key into ./phosphor-paths.ts's typed path-data record. The
 * wrapper resolves a custom Phosphor name FIRST (a string can only ever be
 * a PhosphorIconName, so this branch never "misses"); a LucideIcon
 * component value falls through to the original lucide-react rendering
 * unchanged. That's the whole of U7's rule in code: lucide-react remains
 * ONLY where the prototype drew no custom glyph — call sites for a glyph
 * the prototype DOES draw pass the string name instead of importing the
 * lucide component at all (see nav-items.ts/tab-items.ts/PlayerControls.tsx
 * etc. for the converted call sites, and this lane's freeze report for the
 * full kept-lucide inventory with a justification per kept item).
 */

export type IconSize = "dense" | "default" | "nav";
export type IconSource = LucideIcon | PhosphorIconName;

export interface IconProps {
  icon: IconSource;
  size?: IconSize;
  /** Override the default 1.75 stroke width. Lucide-only: Phosphor custom
   *  glyphs always render at the spec's fixed 1.55 (README "Icons") —
   *  this prop has no effect once `icon` is a PhosphorIconName. Some
   *  lucide call sites (Sidebar/MobileTabBar's remaining non-custom icons,
   *  MobileHeader's back chevron) pass 1.55 explicitly so weight reads
   *  closer to the custom set alongside it. */
  strokeWidth?: number;
  className?: string;
  "aria-hidden"?: boolean;
  "aria-label"?: string;
}

const SIZE_PX: Record<IconSize, number> = {
  dense: 20,
  default: 24, // also the README "Icons" tab-bar size
  nav: 17, // README "Icons": Phosphor custom set desktop size (sidebar)
};

/** README "Icons": the custom set is stroke 1.55 round caps/joins, fixed —
 *  not a per-call-site knob the way lucide's `strokeWidth` prop is. */
const PHOSPHOR_STROKE_WIDTH = 1.55;

function isPhosphorName(icon: IconSource): icon is PhosphorIconName {
  return typeof icon === "string";
}

export function Icon({
  icon,
  size = "default",
  strokeWidth = 1.75,
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps): React.JSX.Element {
  const hidden = ariaLabel === undefined ? (ariaHidden ?? true) : false;
  const px = SIZE_PX[size];
  const a11yProps = ariaLabel !== undefined ? { "aria-label": ariaLabel, role: "img" as const } : {};

  if (isPhosphorName(icon)) {
    const def = PHOSPHOR_ICONS[icon];
    const isFill = def.variant === "fill";
    return (
      <svg
        width={px}
        height={px}
        viewBox="0 0 24 24"
        fill={isFill ? "currentColor" : "none"}
        stroke={isFill ? "none" : "currentColor"}
        strokeWidth={isFill ? undefined : PHOSPHOR_STROKE_WIDTH}
        strokeLinecap={isFill ? undefined : "round"}
        strokeLinejoin={isFill ? undefined : "round"}
        className={className}
        aria-hidden={hidden}
        {...a11yProps}
      >
        {def.elements.map((el, i) => {
          switch (el.tag) {
            case "path":
              return <path key={i} d={el.d} />;
            case "rect":
              return <rect key={i} x={el.x} y={el.y} width={el.width} height={el.height} rx={el.rx} />;
            case "text":
              // Numerals (seek glyphs' baked-in "15"/"30") are always
              // filled, never stroked, regardless of the glyph's own
              // variant — matches the prototype's own explicit
              // per-element override (fill="currentColor" stroke="none").
              return (
                <text
                  key={i}
                  x={el.x}
                  y={el.y}
                  textAnchor="middle"
                  fontFamily="Archivo, -apple-system, sans-serif"
                  fontSize={7}
                  fontWeight={600}
                  fill="currentColor"
                  stroke="none"
                >
                  {el.value}
                </text>
              );
          }
        })}
      </svg>
    );
  }

  const LucideIconComponent = icon;
  return (
    <LucideIconComponent
      size={px}
      strokeWidth={strokeWidth}
      absoluteStrokeWidth={false}
      className={className}
      aria-hidden={hidden}
      {...a11yProps}
    />
  );
}
