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
  // The docs site is published under loombre.com/docs/, alongside the
  // hand-built marketing pages at the root — so every asset URL, router
  // path and preload hint has to be rooted there, not at /. Left at the
  // default "/", the built site requests /assets/* and collides with the
  // marketing site's own /assets/ directory. `pnpm docs:dev` serves at
  // localhost:4750/docs/ for the same reason, which is what production
  // looks like.
  base: "/docs/",
  cleanUrls: true,
  // Dark by default, matching the marketing pages the reader just came from
  // (loombre.com is dark-only). The toggle stays — this only sets the
  // initial appearance; an explicit user choice is persisted by VitePress
  // and wins on return visits.
  appearance: "dark",
  // Deterministic builds: "last updated" timestamps would depend on git log
  // depth/availability at build time (shallow CI checkouts, worktrees) —
  // off rather than sometimes-right.
  lastUpdated: false,
  srcDir: ".",
  // public/** is the static-assets tree; with srcDir "." VitePress still
  // globs .md files inside it for PAGES (docs/public/fonts/README.md became
  // a published /public/fonts/README route until this exclude). The files
  // themselves ship verbatim either way — this only stops page rendering.
  srcExclude: ["PLAN.md", "PLAYBACK.md", "public/**"],
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
    // The flame mark, copied from the website workspace's brand set
    // (site/public/brand/loombre-mark.svg) so the docs nav carries the same
    // mark as the marketing nav. Served from docs/public — same-origin,
    // img-src 'self' holds.
    logo: "/brand/loombre-mark.svg",
    // The docs hub at loombre.com/docs is a hand-built page belonging to the
    // marketing site, not a VitePress route — so the router has no chunk for
    // it and a client-side navigation there would render this site's own home
    // instead. `target` is what makes it a real navigation: the router skips
    // any link carrying one (vitepress/dist/client/app/router.js), and _self
    // is a no-op for the browser. Setting it here rather than patching the
    // built HTML matters because Vue drops attributes it does not own when it
    // hydrates the nav.
    logoLink: { link: "/docs", target: "_self" },
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
            { text: "Windows (.exe)", link: "/install/windows" },
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
            { text: "Joining Loombre", link: "/user-guide/joining" },
            { text: "Account settings", link: "/user-guide/account-settings" },
            { text: "Browsing your library", link: "/user-guide/browsing" },
            { text: "Watching", link: "/user-guide/watching" },
            { text: "Watching away from home", link: "/user-guide/watching-away-from-home" },
            { text: "Listening to music", link: "/user-guide/music" },
            { text: "Restricted content", link: "/user-guide/restricted-content" },
            { text: "Browsing the restricted zone", link: "/user-guide/restricted-content-browsing" },
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
            { text: "Inviting people", link: "/admin-guide/inviting-users" },
            { text: "Mail", link: "/admin-guide/mail" },
            { text: "Remote access", link: "/admin-guide/remote-access" },
            { text: "Connecting Stash", link: "/admin-guide/connecting-stash" },
            { text: "Capability report", link: "/admin-guide/capability-report" },
            { text: "Jobs dashboard", link: "/admin-guide/jobs-dashboard" },
            { text: "Restart & shut down", link: "/admin-guide/server-power" },
            { text: "System notices", link: "/admin-guide/system-notices" },
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
            { text: "Remote access", link: "/ops/remote-access/" },
            { text: "Mail deliverability notes", link: "/ops/mail-notes" },
            { text: "Backups & restore", link: "/ops/backup" },
            { text: "External PostgreSQL", link: "/ops/external-postgres" },
            { text: "systemd", link: "/ops/systemd" },
            { text: "The loombre command-line tool", link: "/ops/cli" },
            { text: "Updating & verifying releases", link: "/ops/updating" },
            { text: "Tier-0 performance audit runbook", link: "/ops/t0-audit-runbook" },
            { text: "Environment variable reference", link: "/ops/env-reference" },
          ],
        },
        {
          text: "Remote access",
          items: [
            { text: "Choosing a path", link: "/ops/remote-access/" },
            { text: "Loombre Remote", link: "/ops/remote-access/loombre-remote" },
            { text: "Tunnel", link: "/ops/remote-access/tunnel" },
            { text: "Direct", link: "/ops/remote-access/direct" },
            { text: "Home-lab validation runbook", link: "/ops/remote-access/home-lab-validation-runbook" },
            { text: "Appendix: Reverse proxy", link: "/ops/remote-access/reverse-proxy" },
            { text: "Appendix: Built-in ACME (TLS)", link: "/ops/remote-access/acme" },
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
            { text: "Performance budgets", link: "/developer-guide/architecture/performance-budgets" },
            { text: "Security posture (implemented measures)", link: "/developer-guide/architecture/security-posture" },
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
