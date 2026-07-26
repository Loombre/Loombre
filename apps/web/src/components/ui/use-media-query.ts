// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/ui/use-media-query.ts
//
// Small viewport-matching hook, used by SheetOrModal.tsx to pick bottom
// sheet vs desktop dialog. This is a legitimate, narrow use of JS-side
// responsiveness — not the user-agent branching U2 (STATE.md Phosphor
// retheme) forbids. U2's ban is about DIVERGING BEHAVIOR by sniffing a
// user-agent string; matchMedia is a real viewport measurement (same
// signal a CSS @media query would use) and is the only way to choose
// between two structurally different component subtrees, something pure
// CSS can reflow but can't do on its own.

import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches));

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mql = window.matchMedia(query);
    const onChange = (): void => setMatches(mql.matches);
    onChange(); // query string may have changed since the initializer ran
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
