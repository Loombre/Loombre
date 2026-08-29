// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/ui/SegmentedControl.tsx
//
// Item 1 (Wave A, radiogroup sweep): this — and the other 6
// SegmentedControl-family implementations it now consolidates
// (browse/LibraryPills.tsx, browse/SortControl.tsx,
// restricted/ZoneSortControl.tsx, detail/SeasonPillTabs.tsx) — used to ship
// role="tablist"/role="tab" with NO keyboard support beyond plain Tab
// (every segment its own stop, no arrow-key movement, no Home/End) and no
// tabpanel — a real WAI-ARIA violation for a control that behaves exactly
// like a set of mutually-exclusive radio buttons, not a tab strip (STATE.md
// W2+W3 deferral, recorded owner-visible at the time). Rebuilt on the
// WAI-ARIA APG "Radio Group" pattern instead: the track is role="radiogroup",
// each segment is role="radio" + aria-checked, and exactly ONE segment is
// ever in the tab order at a time (tabIndex 0 on the checked segment, -1 on
// every other) — arrow keys move focus AND selection together (mirroring
// how native <input type="radio"> groups behave), Home/End jump to the
// first/last option. home/FeaturedBanner.tsx (icon-only carousel indicator
// dots) carries the identical pattern directly rather than consolidating
// here, since it does not fit this component's plain-label shape. (The
// other historical carrier, admin/settings/RegistryFilterBar.tsx, was
// deleted by the UIFIX-2026-08-29 Advanced rework; ui/Chip.tsx's
// FilterChip remains the chip-shaped variant.)

import { useRef, useState } from "react";
import styles from "./SegmentedControl.module.css";

export interface SegmentedControlOption {
  value: string;
  label: React.ReactNode;
}

function normalizeOptions(options: string[] | SegmentedControlOption[]): SegmentedControlOption[] {
  return options.map((option) => (typeof option === "string" ? { value: option, label: option } : option));
}

export interface SegmentedControlProps {
  options: string[] | SegmentedControlOption[];
  /** Controlled active value — when supplied, the caller owns state and
   *  `onChange` is the only way this component's selection moves. Omit for
   *  the original uncontrolled mode (`defaultValue`), still used by
   *  callers that manage "controlled" behavior via a remount `key` instead
   *  (e.g. UsersSection.tsx). */
  value?: string | undefined;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** D-2 (STATE.md W2+W3): the track hugs its segments (fit-content) by
   *  default — never stretches to fill the container. Pass true only when
   *  a caller deliberately wants the track to fill available width. */
  fullWidth?: boolean;
  /** Extra class merged onto the track — a caller's own CSS-module
   *  `composes:` override (e.g. ZoneSortControl's warning-toned active
   *  fill, SeasonPillTabs' mobile horizontal-scroll-strip presentation).
   *  Never a replacement for the shared track styling, always additive. */
  className?: string | undefined;
  /** Same additive-composition contract as `className`, for every segment
   *  button. */
  segmentClassName?: string | undefined;
  "aria-label"?: string | undefined;
}

export function SegmentedControl({
  options,
  value,
  defaultValue,
  onChange,
  fullWidth,
  className,
  segmentClassName,
  "aria-label": ariaLabel,
}: SegmentedControlProps): React.JSX.Element {
  const normalized = normalizeOptions(options);
  const [internalActive, setInternalActive] = useState<string | undefined>(defaultValue ?? normalized[0]?.value);
  const active = value ?? internalActive;
  const segmentRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function select(next: string): void {
    if (value === undefined) setInternalActive(next);
    onChange?.(next);
  }

  function focusAndSelect(index: number): void {
    const target = normalized[index];
    if (!target) return;
    segmentRefs.current[index]?.focus();
    select(target.value);
  }

  // d4-a2.94 (AQ/d3-aq2-adjacent): the keys handled here are CONSUMED —
  // preventDefault alone left them propagating to window, where
  // VideoPlayer's keydown shortcut (which only skips INPUT/TEXTAREA
  // targets) ALSO seeked ±10 s per arrow press with the /watch quality
  // dock focused — the same double-handler shape, and the same fix, as
  // the Scrubber's d3-aq1: stop propagation for handled keys and ONLY
  // those, so an unhandled key (Space/f/m) still reaches the player's
  // window shortcuts.
  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        focusAndSelect((index + 1) % normalized.length);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        focusAndSelect((index - 1 + normalized.length) % normalized.length);
        break;
      case "Home":
        focusAndSelect(0);
        break;
      case "End":
        focusAndSelect(normalized.length - 1);
        break;
      default:
        // NOT handled: neither default nor propagation is touched.
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  // Roving tabindex target: the checked segment when one matches, else the
  // first segment (mirrors a native radio group with nothing checked yet —
  // Tab still lands somewhere sane).
  const activeIndex = Math.max(
    0,
    normalized.findIndex((option) => option.value === active),
  );

  return (
    <div className={[styles.track, className].filter(Boolean).join(" ")} data-full-width={fullWidth || undefined} role="radiogroup" aria-label={ariaLabel}>
      {normalized.map((option, index) => (
        <button
          key={option.value}
          ref={(el) => {
            segmentRefs.current[index] = el;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === active}
          data-active={option.value === active}
          tabIndex={index === activeIndex ? 0 : -1}
          className={[styles.segment, segmentClassName].filter(Boolean).join(" ")}
          onClick={() => select(option.value)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
