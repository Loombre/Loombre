// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/matrix/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
  {
    // docs/PLAYBACK.md §0 law 1 ("Purity. plan() performs no I/O, reads no
    // environment, calls no clock. Everything it needs arrives as
    // arguments; identical inputs produce a byte-identical serialized
    // plan."): packages/playback-engine/src may not reach for wall-clock
    // time, process/environment state, or unseeded randomness directly —
    // those would each break determinism/purity in a way dependency-cruiser
    // (which only sees imports, not global reads) can't catch. matrix/ is
    // exempt (globally ignored above) and test/ is exempt too — the
    // property-test harness (matrix/lib/prng.ts) uses a SEEDED PRNG
    // instead of Math.random precisely because src can't use it either.
    files: ["packages/playback-engine/src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "Date",
          message:
            "docs/PLAYBACK.md §0 law 1: plan() calls no clock — the clock is an argument (CLAUDE.md invariant 2). Never construct Date/Date.now() in packages/playback-engine/src.",
        },
        {
          name: "process",
          message:
            "docs/PLAYBACK.md §0 law 1: plan() reads no environment — packages/playback-engine/src must not touch `process` (env, platform, etc).",
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message:
            "docs/PLAYBACK.md §0 law 1: plan() is pure — identical inputs must produce a byte-identical plan, which unseeded Math.random() breaks by construction. packages/playback-engine/src may not call it.",
        },
      ],
    },
  },
);
