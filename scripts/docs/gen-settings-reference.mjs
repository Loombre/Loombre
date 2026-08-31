#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/docs/gen-settings-reference.mjs
//
// Addendum A, lane D1 (STATE.md "## Addendum A", deliverable 4) — the REAL
// generator for the admin-guide settings reference page, reading
// packages/shared/src/settings-registry.ts's SETTINGS_REGISTRY (lane S1,
// landed 4a65fab) directly. Supersedes this file's original stub (it
// printed a "pending lane S1" placeholder; the seam is now live).
//
// RUNTIME: must be invoked via `tsx` (node_modules/.bin/tsx), not plain
// `node` — see scripts/docs/build.mjs's call site. The registry is
// TypeScript source with no committed compiled output (packages/shared
// builds to a gitignored dist/), and this lane decided AGAINST importing
// dist/: relying on dist/ would make this generator's correctness depend
// on an implicit ordering guarantee (some earlier `pnpm gate` step, e.g.
// typecheck's turbo `^build` dependency, happening to have built
// packages/shared first) that this script has no way to verify or enforce
// itself, and would silently read STALE compiled output if
// packages/shared's source changed without a rebuild in between — a real
// risk while lane S3 is concurrently editing settings-registry.ts
// (requiresRestart flips, per the orchestrator's own note). Importing the
// .ts source directly via tsx has neither problem: it's always current,
// with no ordering dependency on any other gate step. tsx is already a
// root devDependency (no new install).
//
// COMMITTED, NOT HAND-EDITED: docs/admin-guide/settings-reference.md IS
// committed to the repo (git-tracked, same as any other doc page) — it is
// NOT a build artifact excluded from version control. `pnpm docs:build`
// regenerates it from the registry on every run, then scripts/docs/build.mjs's
// drift check (`git diff --exit-code` against the committed copy) fails the
// build if regenerating produced different content than what's committed —
// that check is exactly what depends on this file being committed in the
// first place. This is the no-drift guarantee: the page can never diverge
// from the registry, because any divergence fails the build until the
// regenerated file is re-committed. Never hand-edit it directly; edit
// packages/shared/src/settings-registry.ts and re-run `pnpm docs:build`.
//
// SCOPE: admin-guide/settings-reference.md covers scope:'ui' entries only
// (the ones an admin can actually see/edit in the settings screen once
// lane S2 builds it) — scope:'env-only' entries have no UI surface at all
// and belong to the Operator Guide's env-reference page instead
// (gen-env-reference.mjs), which also lists the env-PIN variable for every
// UI entry that carries one (the operator-facing half of the same fact
// this page states from the admin side).
//
// REGISTER: entry.description is reproduced VERBATIM (not paraphrased) —
// explicit instruction from the orchestrator so the settings screen
// (reading this same registry) and this documentation page can never show
// different wording for the same setting. Since the W13b copy sweep
// (D-7, 2026-08-07) descriptions are uniformly plain task-oriented
// language, and the precise technical facts live in the registry's
// OPTIONAL `technicalDetails` field (rendered as an info tooltip in the
// settings screen) — this page renders BOTH layers (description verbatim,
// then a "Technical details" line) so the generated reference never loses
// the facts the settings screen still carries.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS_REGISTRY } from "../../packages/shared/src/settings-registry.js";
import { ADMIN_CATEGORY_ORDER, ADMIN_CATEGORY_TITLES, titleFor, slugify } from "./lib/settings-titles.mjs";
import { formatDefaultWithTiers } from "./lib/settings-format.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const OUTPUT_PATH = join(REPO_ROOT, "docs", "admin-guide", "settings-reference.md");

const uiEntries = SETTINGS_REGISTRY.filter((entry) => entry.scope === "ui");

// T04-1 per-key Docker caveats: docker-compose.prod.yml's server/worker
// `environment:` blocks forward only an explicit variable list into the
// containers (`loombre.env` values are Compose interpolation input, never
// injected wholesale), so these entries' pin variables never reach the
// server/worker processes under the shipped Docker Compose distribution.
// The TLS/ACME group is unforwarded deliberately (MRV-R5: the Docker
// distribution stays reverse-proxy-only); LOOMBRE_WG_PORT gets a bespoke
// note because the compose file DOES read it — as interpolation input for
// the published host UDP port mapping — without ever passing it to the
// process, so the setting and the variable must be changed together.
// Explicit constants by design, not derived from the compose file — the
// mechanical derivation is the M20 rework, deferred to its own pass; keep
// these lists in sync with docker-compose.prod.yml's environment: blocks
// by hand until then.
const DOCKER_UNFORWARDED_PLAIN_VARS = new Set([
  "LOOMBRE_RATE_LOGIN",
  "LOOMBRE_RATE_REFRESH",
  "LOOMBRE_RATE_UNLOCK",
  "LOOMBRE_RATE_CURRENT_PASSWORD",
  "LOOMBRE_RATE_SETUP",
  "LOOMBRE_RATE_CAPABILITIES",
  "LOOMBRE_RATE_EXPORT",
  "LOOMBRE_RATE_MEDIA_TOKEN",
  "LOOMBRE_RATE_CLAIM",
  "LOOMBRE_RATE_PASSWORD_RESET",
  "LOOMBRE_RATE_PROBE",
  "LOOMBRE_RATE_LOGIN_BY_IDENTIFIER",
  "LOOMBRE_RATE_REFRESH_BY_DEVICE",
  "LOOMBRE_RATE_SEARCH",
  "LOOMBRE_UPDATE_CHECK",
  "LOOMBRE_WG_SUBNET",
  "LOOMBRE_WG_ENDPOINT_HOST",
  "LOOMBRE_CLOUDFLARED_PATH",
  "LOOMBRE_TUNNEL_HOSTNAME",
]);
const DOCKER_UNFORWARDED_TLS_VARS = new Set([
  "LOOMBRE_TLS_MODE",
  "LOOMBRE_ACME_DOMAINS",
  "LOOMBRE_ACME_CHALLENGE_TYPE",
  "LOOMBRE_ACME_TOS_AGREED",
]);

function dockerCaveatFor(envVar) {
  if (envVar === "LOOMBRE_WG_PORT") {
    return (
      "- **Running Loombre in Docker?** The shipped Compose setup passes only an explicit list of variables " +
      "into the containers, and `LOOMBRE_WG_PORT` isn't one of them — setting it in `loombre.env` never " +
      "reaches the server process. The Compose file *does* read it to pick which host UDP port it publishes, " +
      "so it must match this setting: if you change one, change both — nothing connects them automatically."
    );
  }
  if (DOCKER_UNFORWARDED_TLS_VARS.has(envVar)) {
    return (
      `- **Running Loombre in Docker?** \`${envVar}\` is deliberately not passed into the containers: ` +
      "the Docker distribution handles HTTPS with a reverse proxy in front of Loombre, never in-process — " +
      "see the [Docker install guide](/install/docker). Setting it in `loombre.env` has no effect there."
    );
  }
  if (DOCKER_UNFORWARDED_PLAIN_VARS.has(envVar)) {
    return (
      "- **Running Loombre in Docker?** The shipped Compose setup passes only an explicit list of variables " +
      `into the containers, and \`${envVar}\` isn't one of them — setting it in \`loombre.env\` has no ` +
      "effect there. Change the setting here on the settings screen instead, or have whoever installed " +
      "Loombre add the variable to the compose file's `environment:` blocks."
    );
  }
  return undefined;
}

const byCategory = new Map();
for (const entry of uiEntries) {
  if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
  byCategory.get(entry.category).push(entry);
}

const knownCategories = new Set(ADMIN_CATEGORY_ORDER);
const unmappedCategories = [...byCategory.keys()].filter((c) => !knownCategories.has(c));
if (unmappedCategories.length > 0) {
  console.warn(
    `gen-settings-reference: WARNING — categor${unmappedCategories.length === 1 ? "y" : "ies"} not in ` +
      `ADMIN_CATEGORY_ORDER (scripts/docs/lib/settings-titles.mjs), appended at the end with a generic ` +
      `heading: ${unmappedCategories.join(", ")}. Add a friendly title/blurb for full presentation quality.`,
  );
}
const categoryOrder = [...ADMIN_CATEGORY_ORDER.filter((c) => byCategory.has(c)), ...unmappedCategories];

function renderSetting(entry) {
  const title = titleFor(entry.key);
  const lines = [`### ${title}`, "", `<small>Setting key: \`${entry.key}\`</small>`, ""];

  lines.push(entry.description, "");

  // W13b (D-7 two-layer copy): the settings screen shows this in the
  // per-key info tooltip; the reference page states it inline so the
  // generated docs keep every technical fact the old single-layer
  // descriptions used to carry.
  if (entry.technicalDetails) {
    lines.push(`- **Technical details:** ${entry.technicalDetails}`);
  }
  lines.push(`- **Default:** ${formatDefaultWithTiers(entry)}`);
  if (entry.tierDefaults) {
    lines.push(
      "  (varies by hardware tier — see [Install: system requirements](/install/#system-requirements) for what Tier 0/1/2 mean)",
    );
  }
  lines.push(
    entry.requiresRestart
      ? "- **Applies:** after a restart. Saving this shows a reminder banner until the server restarts — Settings → Server → Power has the restart button."
      : "- **Applies:** immediately — no restart needed.",
  );
  if (entry.caution) {
    lines.push(`- **Note:** ${entry.caution}`);
  }
  if (entry.envVar) {
    lines.push(
      `- **Can be locked:** if \`${entry.envVar}\` is set by whoever installed Loombre, this setting becomes fixed to that value and shows as controlled by the environment here — ask them, or see the [Operator Guide's environment reference](/ops/env-reference).`,
    );
    // T04-1: the per-key Docker caveat, emitted only for pin variables the
    // shipped compose file never forwards — see dockerCaveatFor above.
    const dockerCaveat = dockerCaveatFor(entry.envVar);
    if (dockerCaveat) lines.push(dockerCaveat);
  }
  lines.push("");
  return lines.join("\n");
}

const lines = [
  "# Settings reference",
  "",
  "<!-- GENERATED by scripts/docs/gen-settings-reference.mjs from",
  "     packages/shared/src/settings-registry.ts (SETTINGS_REGISTRY) — do not",
  "     edit by hand, edits are overwritten on the next `pnpm docs:build`.",
  "     Setting descriptions below are reproduced VERBATIM from the registry",
  "     (the same text the settings screen renders) — see this script's",
  '     header comment for why. Per-key "Running Loombre in Docker?" notes',
  "     (T04-1): docker-compose.prod.yml's environment: blocks forward only",
  "     an explicit variable list, so the annotated keys' pin variables never",
  "     reach the containers — the TLS/ACME group deliberately so (MRV-R5:",
  "     the Docker distribution stays reverse-proxy-only); LOOMBRE_WG_PORT is",
  "     additionally compose-interpolation input for the published host UDP",
  "     port (docker-compose.prod.yml ports mapping,",
  "     installers/docker/loombre.env.example). These notes must be emitted",
  "     by the generator identically or the docs:build drift check fails. -->",
  "",
  "Every setting Loombre's settings screen lets you change, grouped the way " +
    "the screen groups them, generated directly from the same source the " +
    "settings screen itself reads — so this page can never drift from what " +
    "you actually see there.",
  "",
  "## How to read this page",
  "",
  "- **Applies immediately** means the change takes effect right away.",
  // The "Applies after a restart" legend renders ONLY when at least one
  // listed (ui-scope) entry actually carries requiresRestart:true —
  // today none do (lane S3's hot-reload migration made every UI setting
  // hot-applying; review R-F6), and a legend explaining a state the page
  // can never show is a promise the product doesn't keep. The banner
  // machinery itself stays (settings.service.spec.ts pins it via a
  // synthetic registry) for the first future key that can't hot-apply —
  // this bullet comes back automatically with it.
  ...(uiEntries.some((entry) => entry.requiresRestart)
    ? [
        "- **Applies after a restart** means Loombre saves your change now but " +
          "keeps using the old value until the server restarts — you'll see a " +
          "reminder banner in the meantime, and **Settings → Server → Power** " +
          "has a [restart button](server-power.md) that applies it. Nothing " +
          "currently playing is ever interrupted just by saving.",
      ]
    : []),
  "- **Can be locked** means whoever installed Loombre can fix a setting to " +
    "one value from outside the settings screen. When that's done, this " +
    "screen shows the setting as controlled by the environment and you " +
    "can't change it here — ask them if you need it changed.",
  "",
];

for (const category of categoryOrder) {
  const meta = ADMIN_CATEGORY_TITLES[category] ?? {
    title: category,
    blurb: "",
  };
  lines.push(`## ${meta.title}`, "");
  if (meta.blurb) lines.push(meta.blurb, "");
  const entries = byCategory.get(category);
  for (const entry of entries) {
    lines.push(renderSetting(entry));
  }
}

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n");

console.log(
  `gen-settings-reference: wrote ${uiEntries.length} setting(s) across ${categoryOrder.length} categor${categoryOrder.length === 1 ? "y" : "ies"} -> docs/admin-guide/settings-reference.md`,
);

// Sanity check only (not a hard gate): flags a heading whose slug would be
// empty, which would make an env-reference.md cross-link to it silently
// break. Cheap to assert here rather than a full test file for a doc
// generator.
for (const entry of uiEntries) {
  if (entry.envVar && !slugify(titleFor(entry.key))) {
    console.warn(`gen-settings-reference: WARNING — empty anchor slug for "${entry.key}", cross-links will break.`);
  }
}
