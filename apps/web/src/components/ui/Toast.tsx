// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/ui/Toast.tsx
//
// Phosphor toast (design/phosphor/README.md "Interactions & behavior →
// Feedback": "All confirmations are a single bottom-center toast: 999px
// pill, accent dot, uppercase mono, 2.6s auto-dismiss. No inline success
// banners except the registry's per-field SAVED line."). STATE.md Phosphor
// W1b scope.
//
// Context+hook shape follows the existing provider convention (see
// components/restricted/RestrictedProvider.tsx's useRestricted(): a
// `createContext` + Provider component + a `useX()` hook that throws
// outside the provider). Mounting <ToastProvider> app-wide (the
// components/providers/AppProviders.tsx wiring, alongside RestrictedProvider
// and MusicPlayerProvider) is OUT OF SCOPE for this lane — that file is not
// under components/ui/**, and no sibling lane owns it either; flagged as
// deferred in the W1b freeze report. Every Wave-2 flow that wants
// useToast() needs a <ToastProvider> somewhere above it in the tree; the
// styleguide demo mounts its own local instance to exercise the primitive
// without that root wiring.
//
// Single-slot design (README: "new toast replaces the current one" — no
// stacking): showToast() always overwrites whatever is currently showing
// and restarts the 2.6s timer, rather than queuing. The viewport is
// PERMANENTLY mounted (not conditionally rendered) so the aria-live region
// exists in the accessibility tree from first paint — some assistive tech
// only reliably announces content that changes inside an already-present
// live region, not one that appears fresh together with its content.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button.js";
import styles from "./Toast.module.css";

export type ToastVariant = "accent" | "warning" | "danger";

/** UD-20c (UIFIX-2026-08-29, Lane K): an ADDITIVE optional action slot.
 *  Settings › Advanced autosaves on change and offers the correction after
 *  the fact — "N settings reset to default · Undo" — which needs a real
 *  control inside the toast rather than a second banner. Existing callers
 *  pass no `action` and are byte-identical to before. */
export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastOptions {
  /** Dot color. "accent" (default) follows the user's chosen accent color
   *  (design/phosphor/README.md "Accent as a user preference"); "warning"/
   *  "danger" are fixed semantic colors independent of that preference
   *  (e.g. the restricted-zone re-lock toast). */
  variant?: ToastVariant;
  /** Override the default 2.6s auto-dismiss. Exists mainly for tests and
   *  the rare flow that legitimately needs a longer read time — most
   *  callers should omit this and get the README's exact 2.6s. */
  durationMs?: number;
  /** Optional trailing control (UD-20c). Invoking it dismisses the toast
   *  first, so the action never fires twice and the live region empties the
   *  moment the correction is taken. */
  action?: ToastAction;
}

export interface ToastContextValue {
  showToast: (message: string, options?: ToastOptions) => void;
  /** Clears the current toast immediately, before its timer would have. */
  dismiss: () => void;
}

const DEFAULT_DURATION_MS = 2600;

const ToastContext = createContext<ToastContextValue | null>(null);

interface ToastState {
  key: number;
  message: string;
  variant: ToastVariant;
  action: ToastAction | null;
}

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<ToastState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextKeyRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setState(null);
  }, [clearTimer]);

  const showToast = useCallback(
    (message: string, options?: ToastOptions) => {
      clearTimer();
      nextKeyRef.current += 1;
      setState({
        key: nextKeyRef.current,
        message,
        variant: options?.variant ?? "accent",
        action: options?.action ?? null,
      });
      const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setState(null);
      }, durationMs);
    },
    [clearTimer],
  );

  // Unmount safety net only — clearTimer() is already called at the start
  // of every showToast()/dismiss(), this just stops a stray timeout from
  // firing setState after the provider itself is gone.
  useEffect(() => clearTimer, [clearTimer]);

  const value = useMemo<ToastContextValue>(() => ({ showToast, dismiss }), [showToast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.viewport} data-visible={state !== null}>
        <div className={styles.toast} aria-live="polite" aria-atomic="true">
          <span className={styles.dot} data-variant={state?.variant ?? "accent"} aria-hidden="true" />
          {/* `key` forces a fresh text node even for two identical
              consecutive messages, so a repeat toast is still announced
              (aria-live fires on DOM mutation, and React bails out of
              re-rendering unchanged text). */}
          <span key={state?.key ?? 0} className={styles.message}>
            {state?.message ?? ""}
          </span>
          {/* UD-20c: the viewport is `pointer-events: none` (a toast is a
              passive notification), so the ONE control that is not passive
              re-enables them on itself. Inline because that is a functional
              property of this element, not a look — Toast.module.css stays
              exactly as it was, and a toast with no action still has no
              clickable surface at all. */}
          {state?.action && (
            <Button
              type="button"
              variant="ghost"
              style={{ pointerEvents: "auto" }}
              onClick={() => {
                const run = state.action?.onAction;
                dismiss();
                run?.();
              }}
            >
              {state.action.label}
            </Button>
          )}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast() called outside <ToastProvider>");
  return ctx;
}
