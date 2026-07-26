// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Enforces the architecture invariants from docs/PLAN.md §3/§4.5:
 *  - Catalog / Playback / Session server modules share only IDs (never import
 *    one another).
 *  - No module outside packages/db may touch the raw pg/kysely drivers — the
 *    query-guard is the only door to Postgres.
 *  - packages/playback-engine stays a pure decision function: no framework,
 *    no I/O, no workspace deps except packages/shared.
 *  - No circular dependencies anywhere.
 */

// Every Node.js builtin module (core + its documented submodules), used by
// the playback-engine purity rule below (docs/PLAYBACK.md §0 law 1:
// "plan() performs no I/O, reads no environment, calls no clock" —
// packages/playback-engine/src may import NONE of these, not just the
// handful an author happens to remember). Matched both as the "node:"-
// prefixed specifier (mandatory style) and the legacy bare specifier, since
// source can write either and dependency-cruiser resolves both to the same
// core module.
const NODE_BUILTINS = [
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "sqlite",
  "stream",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "test",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
].join("|");

module.exports = {
  forbidden: [
    {
      name: "catalog-no-cross-module-import",
      comment:
        "apps/server/src/catalog may not import playback or session — modules share only IDs (D2).",
      severity: "error",
      from: { path: "^apps/server/src/catalog" },
      to: { path: "^apps/server/src/(playback|session)" },
    },
    {
      name: "playback-no-cross-module-import",
      comment:
        "apps/server/src/playback may not import catalog or session — modules share only IDs (D2).",
      severity: "error",
      from: { path: "^apps/server/src/playback" },
      to: { path: "^apps/server/src/(catalog|session)" },
    },
    {
      name: "session-no-cross-module-import",
      comment:
        "apps/server/src/session may not import catalog or playback — modules share only IDs (D2).",
      severity: "error",
      from: { path: "^apps/server/src/session" },
      to: { path: "^apps/server/src/(catalog|playback)" },
    },
    {
      name: "no-raw-db-driver-outside-packages-db",
      comment:
        "pg/pg-*/kysely may only be imported from packages/db — the query-guard makes unfiltered queries impossible by construction (the single-database-door invariant). pg-boss is carved out of the `pg-[^/]+` glob (it would otherwise match) and governed instead by the dedicated 'pg-boss-outside-jobs-forbidden' rule below, since it is packages/jobs's queue driver, not a raw catalog-data access path.",
      severity: "error",
      from: { pathNot: "^packages/db" },
      to: { path: "(^|/)node_modules/(pg|pg-(?!boss($|/))[^/]+|kysely)($|/)" },
    },
    {
      name: "pg-boss-outside-jobs-forbidden",
      comment:
        "pg-boss (the queue driver, D5) is packages/jobs's implementation detail — only packages/jobs may import it directly. Every other package (including apps/worker) uses @loombre/jobs's typed createJobQueue()/enqueue()/work() abstraction instead of pg-boss's raw API.",
      severity: "error",
      from: { pathNot: "^packages/jobs(/|$)" },
      to: { path: "(^|/)node_modules/pg-boss($|/)" },
    },
    {
      name: "playback-engine-no-framework-or-node-io",
      comment:
        "packages/playback-engine/src is a pure decision function (docs/PLAYBACK.md §0 law 1: no I/O, no environment, no clock): it may import NO Node.js builtin — not `node:fs`/`node:os`/`node:child_process` alone, EVERY builtin module, prefixed or bare — and no framework/server package (NestJS, Express, Fastify, Koa). Note: matrix/ and test/ are excluded from this whole dependency graph (options.exclude below), so this rule only ever sees packages/playback-engine/src in practice; the from-path is pinned to /src explicitly anyway so that stays true even if the global exclude ever changes. Raw pg/kysely imports are separately forbidden repo-wide by 'no-raw-db-driver-outside-packages-db' above, which already covers playback-engine too.",
      severity: "error",
      from: { path: "^packages/playback-engine/src" },
      to: {
        path: `(^|/)node_modules/(@nestjs/|express($|/)|fastify($|/)|koa($|/))|^node:(${NODE_BUILTINS})$|(^|/)node_modules/node:(${NODE_BUILTINS})($|/)|^(${NODE_BUILTINS})$|(^|/)node_modules/(${NODE_BUILTINS})($|/)`,
      },
    },
    {
      name: "playback-engine-only-shared-workspace-dep",
      comment:
        "packages/playback-engine may depend on packages/shared only — no other workspace package (docs/PLAYBACK.md §0).",
      severity: "error",
      from: { path: "^packages/playback-engine" },
      to: {
        path: "^(apps|packages)/",
        pathNot: "^packages/(shared|playback-engine)(/|$)",
      },
    },
    {
      name: "no-internal-db-outside-worker",
      comment:
        "@loombre/db/internal (packages/db/src/internal) is the guard-free scanner/import writer surface (P1.13) — writes are not viewer-scoped, so it deliberately bypasses the restricted-content query guard. Only apps/worker (the scanner/import runtime), packages/jobs (the queue driver's ledger-mirroring writes into the `jobs` table — see packages/jobs/src/ledger.ts), and packages/db itself (tests/seed included) may import it; every other package — notably apps/server, which serves viewer-scoped requests — must go through the guarded query functions in packages/db's public barrel. `to.path` matches both `src/internal` (relative imports within packages/db itself, e.g. its own tests) and `dist/internal` (Phase 4 Wave 3, lane STRUCT: @loombre/db's package.json exports now resolve \"@loombre/db/internal\" to compiled dist output for every OTHER consumer — see the doNotFollow comment in options below for why the rule would otherwise go inert).",
      severity: "error",
      from: {
        pathNot: "^(apps/worker|packages/jobs|packages/db)(/|$)",
      },
      to: {
        path: "^packages/db/(src|dist)/internal(/|$)",
      },
    },
    {
      name: "no-circular",
      comment: "Circular dependencies make module boundaries meaningless.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // `dist` moved from `exclude` to `doNotFollow` (Phase 4 Wave 3, lane
    // STRUCT — same enforcement-gap SHAPE as the node_modules discovery
    // below, found while giving @loombre/db/@loombre/jobs real dist builds):
    // `exclude` doesn't just stop recursion, it removes the module from
    // dependency-cruiser's view ENTIRELY — including as the resolved
    // target of an edge from outside the excluded path. @loombre/db's
    // "./internal" subpath now resolves (via package.json exports) to
    // `packages/db/dist/internal/index.js`; with `dist` under `exclude`,
    // that target vanished from the graph and 'no-internal-db-outside-
    // worker' below went silently inert for every consumer (proven: a
    // planted violating import in apps/server/src produced zero errors).
    // `doNotFollow` (like node_modules already gets) keeps the resolved
    // file as a graph LEAF — visible to `to` pattern matching — while
    // still refusing to recurse into it or walk it as an independent entry
    // point during the initial `apps`/`packages` directory scan (verified:
    // module count unaffected by this change, no compiled dist/**.js files
    // appear as their own `source` entries). `.next`/`.turbo`/`test`/
    // `matrix` stay in `exclude` — nothing resolves an import edge into
    // any of those, so there is no equivalent gap to reopen for them.
    doNotFollow: {
      path: "(^|/)node_modules(/|$)|^(apps|packages)/[^/]+/dist(/|$)",
    },
    // NOTE (discovered while proving the playback-engine purity rule fires,
    // docs/PLAYBACK.md §11 step 1 deliverable 6): the previous
    // `includeOnly: "^(apps|packages)/"` silently dropped EVERY
    // node_modules/core-module dependency from the graph before rules ever
    // saw it — meaning 'no-raw-db-driver-outside-packages-db',
    // 'pg-boss-outside-jobs-forbidden', and
    // 'playback-engine-no-framework-or-node-io' were all structurally inert
    // (their `to` patterns could never match anything). Widened to also
    // admit node_modules/ paths and core-module leaves as graph nodes —
    // `doNotFollow` above still stops recursion INTO them, so this cannot
    // introduce new circular-dependency findings, only make the existing
    // to-node_modules/to-core-module rules actually enforce what their
    // comments always claimed. A full apps+packages cruise with this
    // widening in place found zero pre-existing violations.
    includeOnly: `^(apps|packages)/|(^|/)node_modules/|^node:(${NODE_BUILTINS})$|^(${NODE_BUILTINS})$`,
    // Scoped to WORKSPACE package-root dirs only (orchestrator review fix
    // on the includeOnly discovery above): the previous unanchored
    // `(^|/)(dist|...|node_modules|...)(/|$)` also matched node_modules
    // itself AND dependency entry points inside packages (e.g.
    // node_modules/kysely/dist/...), so to-node_modules rules stayed inert
    // even after includeOnly admitted them — proven empirically by an
    // `import "pg"` in apps/server producing zero violations. The
    // single-bounded-segment form below ([^/]+, no backtracking-prone
    // lookaheads — dependency-cruiser's safe-regex check rejects those)
    // excludes exactly the workspace build-artifact/test dirs at package
    // roots that nothing legitimately resolves an import edge into
    // (apps/web/.next, every package's .turbo, test/, packages/
    // playback-engine/matrix) — `dist` is deliberately NOT here any more,
    // see the doNotFollow comment above.
    exclude: {
      path: "^(apps|packages)/[^/]+/(\\.next|\\.turbo|test|matrix)(/|$)",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.base.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default", "types"],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
