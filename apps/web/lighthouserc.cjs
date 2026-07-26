// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/lighthouserc.cjs
//
// P2.6 Lighthouse budget, ENFORCED: performance >= 0.90 on Lighthouse's
// default THROTTLED mobile profile (docs/PLAN.md §9.3: "Lighthouse perf
// >= 90 in CI on a throttled profile"). We deliberately do NOT set
// `collect.settings` here — leaving it unset means LHCI runs Lighthouse's
// own default config, which is mobile form factor + simulated slow-4G/
// mid-tier-CPU throttling. That IS "the throttled profile" the plan names;
// overriding it (e.g. to desktop, or throttlingMethod: 'provided') would
// be us inventing an easier bar than the spec sets.
//
// P2.11 law: this audits the app AS-IS — no test-mode motion/ambient/glass
// stripping exists anywhere in apps/web (grepped clean; the only
// env/media-query gating in the codebase is the standard, real
// `prefers-reduced-motion` accessibility media query, which Chrome leaves
// at its default "no-preference" under LHCI unless explicitly emulated,
// so motion/ambient/glass render exactly as a real visitor would see them).
//
// Audited page: /login, NOT /home or /browse. Why: LHCI's `collect.url`
// navigates a FRESH, unauthenticated Chrome profile — there is no
// mechanism here to carry a real access token into the page before
// Lighthouse's navigation starts. /home and /browse both redirect
// unauthenticated visitors straight to /login (see apps/web/src/app/home,
// .../browse — both check `getAuthStore().isAuthenticated()` client-side
// and `router.replace("/login")` if not), so auditing those URLs directly
// would just measure /login's redirect-shell, mislabeled. /login itself is
// a real, fully-styled, interactive route (form inputs, the shared Button/
// TextInput components, the app's real CSS/tokens/glass-chrome shell) —
// not a stub — so it's an honest stand-in for "a real page in this app"
// today.
//
// What would change this: seeding a valid access token into the browser
// (localStorage + the in-memory auth store's expected shape) before
// Lighthouse's navigation. LHCI supports `collect.puppeteerScript` for
// exactly this kind of pre-navigation setup, but doing it correctly here
// requires reaching into apps/web/src/lib/auth-store.ts's exact persisted
// shape (memory access token + localStorage refresh/deviceId/serverUrl) —
// a fixture that will drift silently the moment that module changes, with
// no test coverage to catch it (a stale/malformed seeded token would just
// make Lighthouse audit ANOTHER redirect-to-/login, failing silently
// rather than loudly). That's the "flaky in LHCI" tradeoff this file's
// task explicitly calls out. Phase 3/4 should revisit once there's either
// (a) a stable, tested "seed an authenticated browser session" helper
// shared with e2e/browser tests, or (b) a server-side-rendered
// authenticated route LHCI can hit with a cookie/header set via
// `collect.settings.extraHeaders` instead of client-side localStorage.
module.exports = {
  ci: {
    collect: {
      url: ["http://127.0.0.1:3000/login"],
      // Runs with cwd=apps/web (lhci is invoked via that package's own
      // "lighthouse" script), so a plain `pnpm run start` — not
      // `--filter` — is enough and avoids depending on pnpm's workspace-
      // root discovery from a subdirectory.
      startServerCommand: "pnpm run start",
      startServerReadyPattern: "Ready in",
      startServerReadyTimeout: 30_000,
      numberOfRuns: 3,
    },
    assert: {
      assertions: {
        "categories:performance": ["error", { minScore: 0.9 }],
      },
    },
    upload: {
      target: "filesystem",
      outputDir: "./.lighthouseci",
    },
  },
};
