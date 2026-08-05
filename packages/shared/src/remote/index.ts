// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/remote/index.ts
//
// Subpath barrel for `@loombre/shared/remote` (packages/shared/package.json's
// `exports` map) — added by lane U1 (STATE.md "Loombre Remote ...") because
// apps/web is the first consumer to import these modules across the
// PACKAGE boundary rather than from within packages/shared itself. The
// root barrel ("@loombre/shared", src/index.ts) also re-exports these same
// modules alongside ids.ts/crash-dir.ts, which pull in `node:crypto`/
// `node:path` — fine inside the server/worker, fatal in a webpack browser
// build (verified: `next build` fails with UnhandledSchemeError on
// `node:crypto`/`node:path` the moment a web component imports the bare
// root barrel). Every module re-exported here is genuinely framework- and
// Node-free (grepped for `node:` imports — none), so this subpath is safe
// for browser code the way AccountSection.tsx's `@loombre/shared/
// language-codes` import already established the pattern for.

export * from "./provisioning.js";
export * from "./wizard-state.js";
export * from "./posture-model.js";
export * from "./diagnosis.js";
export * from "./comparison.js";
export * from "./diagnosis-guidance.js";
// U2 fix: router-cards.ts (D1) was exported from the ROOT barrel
// (src/index.ts) but missing here — the one subpath browser code is
// actually allowed to import from (this file's own header, and every
// mission brief for this run: "ALL imported via the @loombre/shared/remote
// subpath ONLY — root barrel breaks browser builds"). Found because
// RouterCardView.tsx (U2, this lane) is the FIRST browser consumer of
// router-cards.ts's exports — nothing before this lane imported it from
// apps/web at all. Framework- and Node-free (same as every other module
// re-exported here), so additive and safe.
export * from "./router-cards.js";
