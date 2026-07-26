// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: docs/.vitepress/config.mts
//
// Addendum A, lane D1 (STATE.md "## Addendum A", deliverable 1) — the docs
// site config. VitePress 1.6.4 (orchestrator decision AD2: markdown-first,
// MIT-licensed, no telemetry — see STATE.md's Addendum decisions table).
//
// LAYOUT DECISION (logged): the site is rooted directly over docs/ rather
// than a separate docs-site/ tree that mirrors it. Every existing P4.9-grade
// operator/install page (docs/install/*.md, docs/ops/*.md) stays exactly
// where every other doc in the repo already links to it (README.md,
// STATE.md, CLAUDE.md all use repo-relative paths like
// `docs/ops/reverse-proxy.md`) — rooting the site anywhere else would mean
// either breaking those links or maintaining two copies. New guides
// (user-guide/, admin-guide/, developer-guide/, api-reference/) sit as
// sibling top-level directories under docs/ for the same reason: one tree,
// one set of paths, whether you're reading it on GitHub or on the built
// site.
//
// docs/PLAN.md and docs/PLAYBACK.md are internal specs (CLAUDE.md:
// "Authoritative spec: docs/PLAN.md" / "docs/PLAYBACK.md — playback engine
// spec"), not public-launch documentation — `srcExclude` keeps them out of
// the built site entirely (no route, no sidebar entry, not in the search
// index) while they stay exactly where every doc's cross-references expect
// them, readable in-repo and linked to from the Developer Guide instead
// (see docs/developer-guide/index.md).
//
// OFFLINE / NO-CDN: VitePress's default theme ships Inter as local .woff2
// files in node_modules/vitepress/dist/client/theme-default/fonts/ and its
// build strips the Google Fonts `@import` fallback that appears in the raw
// fonts.css source (the `webfont-marker-begin/end` block; see
// node_modules/vitepress/dist/node/chunk-*.js's `webfontMarkerRE` — verified
// by inspection, not assumed) — a production build never fetches anything
// from fonts.googleapis.com. `search.provider: 'local'` uses VitePress's
// bundled minisearch index (no Algolia, no external service). Nothing in
// this config adds a CDN script, remote font, or analytics snippet.

import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Loombre",
  description: "Self-hosted media streaming platform — documentation",
  lang: "en-US",
  cleanUrls: true,
  // Deterministic builds: "last updated" timestamps would depend on git log
  // depth/availability at build time (shallow CI checkouts, worktrees) —
  // off rather than sometimes-right.
  lastUpdated: false,
  srcDir: ".",
  srcExclude: ["PLAN.md", "PLAYBACK.md"],
  ignoreDeadLinks: false,

  head: [["meta", { name: "referrer", content: "no-referrer" }]],

  // Addendum A doc-lane fix F11(d): `[SCREENSHOT: description]` placeholders
  // (the convention scripts/docs/collect-screenshots.mjs tracks — see that
  // file's own header) are meant for the outstanding-screenshots checklist,
  // not for a real reader's eyes: unhandled, markdown-it renders the raw
  // brackets as literal text on every page that has one. This core rule
  // swaps the placeholder for a plain italic note in the RENDERED output
  // only — it rewrites `state.src` in-memory during this build's parse
  // pass, so the .md source on disk (and collect-screenshots.mjs's own
  // regex match against it) is untouched. Pattern kept byte-identical to
  // that script's `PLACEHOLDER_RE` on purpose — one pattern, two consumers.
  markdown: {
    config: (md) => {
      const PLACEHOLDER_RE = /\[SCREENSHOT:\s*([^\]]+)\]/g;
      md.core.ruler.before("normalize", "strip-screenshot-placeholders", (state) => {
        state.src = state.src.replace(PLACEHOLDER_RE, "*(screenshot coming soon)*");
      });
    },
  },

  themeConfig: {
    logo: undefined,
    nav: [
      { text: "Install", link: "/install/" },
      { text: "User Guide", link: "/user-guide/" },
      { text: "Admin Guide", link: "/admin-guide/" },
      { text: "Operator Guide", link: "/ops/" },
      { text: "Developer Guide", link: "/developer-guide/" },
      { text: "API Reference", link: "/api-reference/" },
    ],

    sidebar: {
      "/install/": [
        {
          text: "Install",
          items: [
            { text: "Overview & requirements", link: "/install/" },
            { text: "Docker / Compose (recommended)", link: "/install/docker" },
            { text: "Linux (tarball + systemd)", link: "/install/linux" },
            { text: "Windows (MSI)", link: "/install/windows" },
            { text: "macOS (.pkg)", link: "/install/macos" },
            { text: "Troubleshooting", link: "/install/troubleshooting" },
          ],
        },
      ],

      "/user-guide/": [
        {
          text: "User Guide",
          items: [
            { text: "Overview", link: "/user-guide/" },
            { text: "Browsing your library", link: "/user-guide/browsing" },
            { text: "Watching", link: "/user-guide/watching" },
            { text: "Listening to music", link: "/user-guide/music" },
            { text: "Restricted content", link: "/user-guide/restricted-content" },
            { text: "Why is this converting?", link: "/user-guide/why-is-it-converting" },
          ],
        },
      ],

      "/admin-guide/": [
        {
          text: "Admin Guide",
          items: [
            { text: "Overview", link: "/admin-guide/" },
            { text: "The setup wizard", link: "/admin-guide/wizard" },
            { text: "Libraries & scanning", link: "/admin-guide/libraries" },
            { text: "Users & permissions", link: "/admin-guide/users-permissions" },
            { text: "Capability report", link: "/admin-guide/capability-report" },
            { text: "Jobs dashboard", link: "/admin-guide/jobs-dashboard" },
            { text: "Plugins", link: "/admin-guide/plugins" },
            { text: "Settings reference", link: "/admin-guide/settings-reference" },
          ],
        },
      ],

      "/ops/": [
        {
          text: "Operator Guide",
          items: [
            { text: "Overview", link: "/ops/" },
            { text: "Reverse proxy", link: "/ops/reverse-proxy" },
            { text: "Built-in ACME (TLS)", link: "/ops/acme" },
            { text: "Backups & restore", link: "/ops/backup" },
            { text: "External PostgreSQL", link: "/ops/external-postgres" },
            { text: "systemd", link: "/ops/systemd" },
            { text: "Updating & verifying releases", link: "/ops/updating" },
            { text: "Tier-0 performance audit runbook", link: "/ops/t0-audit-runbook" },
            { text: "Environment variable reference", link: "/ops/env-reference" },
          ],
        },
      ],

      "/developer-guide/": [
        {
          text: "Developer Guide",
          items: [
            { text: "Overview", link: "/developer-guide/" },
            { text: "Clean clone to green gate", link: "/developer-guide/getting-started" },
            { text: "Contract-first workflow", link: "/developer-guide/contract-workflow" },
            { text: "Adding a metadata provider", link: "/developer-guide/add-a-provider" },
            { text: "Authoring a matrix case", link: "/developer-guide/matrix-authoring" },
            { text: "Glossary", link: "/developer-guide/glossary" },
          ],
        },
        {
          text: "Architecture tour",
          items: [
            { text: "Contract + generated SDK", link: "/developer-guide/architecture/contract-and-sdk" },
            { text: "Catalog, query guard & restricted content", link: "/developer-guide/architecture/catalog-query-guard" },
            { text: "Playback engine & matrix law", link: "/developer-guide/architecture/playback-engine" },
            { text: "Jobs, worker & outbox", link: "/developer-guide/architecture/jobs-worker" },
            { text: "Packaging & release", link: "/developer-guide/architecture/packaging-release" },
          ],
        },
        {
          text: "Plugin developer kit",
          items: [
            { text: "Overview & protocol posture", link: "/developer-guide/plugins/" },
            { text: "The frozen LPP v1 spec", link: "/developer-guide/plugins/spec" },
            { text: "Building your first plugin", link: "/developer-guide/plugins/building-a-plugin" },
            { text: "Conformance testing", link: "/developer-guide/plugins/conformance" },
            { text: "Event subscription mechanics", link: "/developer-guide/plugins/events" },
            { text: "Roadmap: future capabilities", link: "/developer-guide/plugins/roadmap" },
          ],
        },
      ],

      "/api-reference/": [
        {
          text: "API Reference",
          items: [{ text: "Overview", link: "/api-reference/" }],
        },
      ],

      "/reference/": [
        {
          text: "Build reference",
          items: [{ text: "Outstanding screenshots", link: "/reference/screenshots" }],
        },
      ],
    },

    search: {
      provider: "local",
    },

    outline: { level: [2, 3] },

    socialLinks: [{ icon: "github", link: "https://github.com/Loombre/Loombre" }],

    editLink: {
      pattern: "https://github.com/Loombre/Loombre/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the AGPL-3.0-only license. No telemetry, ever.",
      copyright: "Loombre — self-hosted, self-owned",
    },
  },
});
