// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/auth/AuthScreen.tsx
//
// M16 (Optional Mail Transport run): shared brand/layout shell for the new
// unauthenticated pages — /claim/[token], /forgot, /reset/[token], and
// login's own must-change-password step. Extracted rather than copied four
// times: /login/page.tsx's own `.brand`/`.wordmark`/`.tagline`/`.form`
// markup (the BlazeMark + wordmark lockup, D2's stacked-lockup convention)
// is the exact same shape every one of these self-guarding, no-AppShell
// pages needs. /login/page.tsx itself is left untouched — its own header
// comment already documents byte-identical auth logic as a goal for a
// PRIOR retheme lane; extracting its layout now would touch that file for
// a cosmetic reason unrelated to this run's actual scope (the login page
// gains a real functional change instead — the forgot-password link and
// must-change routing, see that file's own header).

import type { ReactNode } from "react";
import { BlazeMark } from "../brand/BlazeMark.js";
import blazeIdle from "../brand/BlazeIdle.module.css";
import styles from "./AuthScreen.module.css";

export function AuthScreen({
  tagline,
  children,
}: {
  tagline?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className={styles.page}>
      <div className={styles.brand}>
        <BlazeMark
          variant="gradient"
          size={56}
          animated
          surface="var(--color-bg)"
          classNames={{ blaze: blazeIdle.blaze!, core: blazeIdle.core! }}
        />
        <span className={styles.wordmark}>Loombre</span>
      </div>
      {tagline && <div className={styles.tagline}>{tagline}</div>}
      <div className={styles.card}>{children}</div>
    </div>
  );
}
