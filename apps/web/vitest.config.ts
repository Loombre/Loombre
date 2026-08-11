// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/vitest.config.ts
//
// jsdom gives us `document`/`window`/`navigator` shapes for the auth-store
// and DOM-adjacent tests; the device-profile tests never rely on jsdom's
// (nonexistent) real media decode support — they inject a mock ProbeEnv
// instead (see device-profile.test.ts's header).
//
// oxc.jsx: tsconfig.json sets "jsx": "preserve" (Next's own SWC compiler
// owns the JSX transform at build time). Vite 8/vitest's default oxc
// transform reads that same tsconfig and refuses to parse ANY .tsx test
// file under "preserve" ("make sure to not set jsx to preserve"). Every
// prior test in this suite was .ts-only (no component under test rendered
// JSX), so this never surfaced until the Phosphor W1b lane added the first
// React-component tests (BottomSheet/Toast). Overriding oxc's jsx mode here
// (automatic runtime, same as Next's) fixes it for every .tsx test without
// touching tsconfig.json or the Next build.

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: { runtime: "automatic" },
  },
  test: {
    environment: "jsdom",
    // Never collect a worktree's copy of these specs (see
    // apps/server/vitest.config.ts's exclude comment).
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
  },
});
