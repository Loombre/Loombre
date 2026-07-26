// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/ui/overlay-hooks.ts
//
// Shared behavior for anything that opens "on top" of the page — the
// Phosphor bottom sheet (BottomSheet.tsx) and, through SheetOrModal.tsx,
// the desktop dialog it swaps for at wider viewports. Factored out so both
// branches get IDENTICAL focus-trap/scroll-lock/escape behavior instead of
// two hand-rolled copies. Today's components/ui/Overlay.tsx demos and the
// live consumers (components/admin/Modal.tsx, components/restricted/
// PinModal.tsx) predate this — they compose Overlay.module.css's CSS but
// have no focus trap, no scroll lock, and no focus-return of their own.
// This file doesn't retrofit them (out of this lane's scope), but it is
// intentionally generic enough that they could adopt it later without
// change.

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  // Deliberately NOT filtering on `offsetParent`/`offsetWidth` etc. to
  // exclude hidden elements: jsdom (this suite's test environment) never
  // computes real layout, so those properties are always zero/null
  // regardless of actual visibility — a filter like that would silently
  // find zero focusable elements in every test. BottomSheet/SheetOrModal
  // content in practice doesn't hide focusable descendants, so the plain
  // selector match is correct for both environments.
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Traps Tab/Shift+Tab focus inside `containerRef` while `active` is true,
 * moves initial focus in (first focusable element, or the container itself
 * as a fallback so at least ONE thing is focused), and returns focus to
 * whatever had it beforehand once `active` goes false again — the
 * "focus trap + focus return" requirement (README "Phone-only additions",
 * STATE.md Phosphor W1b scope).
 *
 * `containerRef`'s element needs `tabIndex={-1}` so the "no focusable
 * descendant" fallback (`container.focus()`) actually works — a plain,
 * tabindex-less <div> silently ignores .focus() in every browser.
 */
export function useFocusTrap(containerRef: React.RefObject<HTMLElement | null>, active: boolean): void {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return undefined;

    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const container = containerRef.current;
    if (container) {
      const focusables = getFocusableElements(container);
      (focusables[0] ?? container).focus();
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Tab") return;
      const node = containerRef.current;
      if (!node) return;
      const focusables = getFocusableElements(node);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey) {
        if (current === first || !node.contains(current)) {
          event.preventDefault();
          last.focus();
        }
      } else if (current === last || !node.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const toRestore = previouslyFocused.current;
      if (toRestore && document.contains(toRestore)) toRestore.focus();
    };
  }, [active, containerRef]);
}

/** Locks body scroll while `active`, restoring whatever inline value (if
 *  any) was there before. Reference-counted via a module-level counter so
 *  two overlays open at once (not a supported UI state today, but cheap
 *  insurance) don't have the first one's close prematurely re-enable
 *  scroll for the second. */
let scrollLockCount = 0;
let previousBodyOverflow = "";

export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;

    if (scrollLockCount === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    scrollLockCount += 1;

    return () => {
      scrollLockCount -= 1;
      if (scrollLockCount === 0) {
        document.body.style.overflow = previousBodyOverflow;
      }
    };
  }, [active]);
}

/** Calls `onEscape` while `active` and the user presses Escape. */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onEscape();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, onEscape]);
}

/**
 * Fallback-timer presence pattern: lets a component keep rendering through
 * a CSS exit transition after its `open` prop goes false, then reports
 * "fully closed" once. Driven primarily by the caller's `onTransitionEnd`
 * (real browsers); `fallbackMs` guarantees `onClosed` still fires even if
 * no transitionend ever arrives (jsdom under test never fires one; a real
 * browser could theoretically skip it too if `display` is yanked out from
 * under the transition elsewhere) — matching the fallback duration to the
 * CSS's own `--motion-base` (240ms) keeps the two mechanisms from racing:
 * whichever fires first wins, cleanup cancels the other.
 */
export function useExitTimer(pending: boolean, fallbackMs: number, onFired: () => void): () => void {
  const firedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!pending) {
      firedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return undefined;
    }
    timerRef.current = setTimeout(() => {
      if (!firedRef.current) {
        firedRef.current = true;
        onFired();
      }
    }, fallbackMs);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
    // `onFired` is intentionally excluded from the dep list: its identity
    // churning on every render must not restart the fallback timer.
  }, [pending, fallbackMs]);

  return () => {
    if (!firedRef.current) {
      firedRef.current = true;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      onFired();
    }
  };
}
