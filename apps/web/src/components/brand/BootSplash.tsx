// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/brand/BootSplash.tsx
//
// STATE.md "Blaze logo rollout" Lane B — the boot-splash component rebuilt
// from design/blaze/assets/loombre-splash.html (design/blaze/README.md
// "Interactions & Behavior"). That HTML file is a motion REFERENCE, never
// shipped (design/blaze/README.md "About the Design Files") — every
// keyframe value/easing/origin/delay/stagger below is copied from it
// exactly (see BootSplash.module.css's header for the line-by-line
// fidelity mapping).
//
// D3 (one geometry, two render modes): mounts <BlazeMark animated> — TWO
// paths, core filled with `--color-bg-splash` (the splash's own surface,
// not the app-wide `--color-bg`) — and attaches this file's rig/blaze/core
// keyframe classes via BlazeMark's `classNames` prop, exactly the hook
// structure BlazeMark.tsx's W0 header documents it was built for.
//
// D4 (scoped bloom exception): the one-shot bloom flash animates
// `filter: brightness() drop-shadow()` on the mark's own <svg> (the `.mark`
// class below, applied via BlazeMark's plain `className` prop — matching
// the reference's `<svg class="mark">`). This is the ONLY place in the
// whole app filter may animate (STATE.md D4) — nowhere else, ever;
// BootSplash.test.tsx's D4 scope-pin test enforces this mechanically.
//
// D6/G5 (boot-log content): see ./boot-log.ts's header for the full
// derivation ledger (this file's U9-style equivalent to app/login/
// page.tsx:12-45) — the short version: LOOMBRE CLIENT/SERVER/SESSION,
// never the reference's fixture CORE/MOUNT/ENGINE lines. Read at mount
// time as a snapshot (useState lazy initializer) — this component is
// presentational and short-lived; it doesn't need to react to auth-store
// changes after it has already rendered once.
//
// D9 (one-shot `booted` gate): a module-level flag, shared by every mount
// point that renders <BootSplash/> — today that's RootPage (app/page.tsx,
// dynamically imported via ./BootSplashLazy.js) and AppShell
// (components/shell/AppShell.tsx, same lazy wrapper), the app's two
// existing "blank frame while the boot decision resolves" spots
// (previously `return null`). Whichever mounts FIRST in this tab's
// lifetime claims the entrance/bloom/idle sequence; every later mount —
// a second blank-frame site if it happens to render afterwards, or any
// subsequent client-side navigation's fresh AppShell instance (AppShell is
// re-instantiated per route, see AppProviders.tsx's header) — renders
// nothing, deferring to Lane C's spinner for ordinary loading gaps. A
// React Context/provider was considered and rejected: the two mount
// points never render simultaneously (one is `/`'s own page, the other is
// nested inside a DIFFERENT route's page — Next renders exactly one route
// at a time), so there is no real race to arbitrate, and a plain
// module-level closure is the smallest correct fix (STATE.md working
// agreement: disk/plain-state over unneeded abstraction).
//
// The "then unmounts" half of D9 is NOT this component's job: its parent
// (RootPage / AppShell) already stops rendering it the instant the real
// boot decision resolves (ready flips true, or the router replaces the
// route entirely) — BootSplash never gates that transition on its own
// animation finishing, so it can never block input once the app is ready
// (STATE.md D9's explicit requirement).

import { useState } from "react";
import { BlazeMark } from "./BlazeMark.js";
import { getBootLogLines } from "./boot-log.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { defaultServerUrlGuess } from "../../lib/server-url.js";
import styles from "./BootSplash.module.css";

/** D9: shared by every <BootSplash/> mount point in this tab's lifetime —
 *  see this file's header for why a plain module closure (not a Context
 *  provider) is the right size for this. */
let booted = false;

function claimBootOnce(): boolean {
  if (booted) return false;
  booted = true;
  return true;
}

/** Test-only reset (vitest isolates module state per test FILE by default —
 *  this repo's own precedent for that limit is lib/auth-store.test.ts's
 *  `vi.resetModules()` use). Never imported by application code. */
export function __resetBootSplashForTests(): void {
  booted = false;
}

export function BootSplash(): React.JSX.Element | null {
  const [shouldPlay] = useState(claimBootOnce);
  const [lines] = useState(() => {
    const store = getAuthStore();
    const snapshot = store.getSnapshot();
    const serverUrl = snapshot.serverUrl || defaultServerUrlGuess();
    return getBootLogLines({ serverUrl, hasStoredSession: store.isAuthenticated() });
  });

  if (!shouldPlay) return null;

  return (
    <div className={styles.splash}>
      <div className={styles.scan} aria-hidden="true" />
      <div className={styles.stack}>
        <BlazeMark
          variant="gradient"
          size={120}
          animated
          surface="var(--color-bg-splash)"
          className={styles.mark!}
          // Non-null assertions: tsconfig.base.json's noUncheckedIndexedAccess
          // types every CSS-module class lookup as `string | undefined`
          // (Card.tsx:36 has the same array-index-access precedent), which
          // exactOptionalPropertyTypes then rejects against
          // BlazeMarkClassNames's `rig?: string` (present-key-must-be-string,
          // not string|undefined) — these three classes are guaranteed to
          // exist (declared right in this file's own .module.css).
          classNames={{ rig: styles.rig!, blaze: styles.blaze!, core: styles.core! }}
        />
        <div className={styles.word}>LOOMBRE</div>
        <div className={styles.boot}>
          {lines.map((line) => (
            <div key={line.label} className={styles.bootLine}>
              <span>{line.label}</span>
              <span className={styles.bootValue}>{line.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
