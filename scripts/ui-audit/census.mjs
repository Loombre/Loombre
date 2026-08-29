#!/usr/bin/env node
// scripts/ui-audit/census.mjs — run UIFIX-2026-08-29 feedback harness, artefact 1.
//
// Counts the three sweep surfaces the run has to move, so a wave gate can read
// the numbers instead of re-deriving them by hand:
//
//   (a) the retired keyframe set  — @keyframes declarations AND animation
//       consumer sites, per name (F3 / Lane 0-A-B-E-H);
//   (b) painted var(--mono-xs) / var(--mono-sm) declarations (G3 / W2-B);
//   (c) hardcoded sub-12px font-size literals (G3 / W2-B).
//
// Zero dependencies, plain node ESM (UD-12: no @playwright/test, no new npm
// dependency of any kind). Reports only — ALWAYS exits 0. Gates read the
// numbers (--json) and decide; this script never decides for them.
//
// Usage:
//   node scripts/ui-audit/census.mjs            # human table
//   node scripts/ui-audit/census.mjs --json     # machine copy
//   node scripts/ui-audit/census.mjs --sites    # table + every file:line
//
// Scope: apps/web/src/**/*.css only. design_handoff_loombre_ui_fixes/ is
// reference-only and is never walked (it lives outside apps/web/src, so the
// scope alone excludes it).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const SCAN_ROOT = join(REPO_ROOT, 'apps', 'web', 'src');

// The six retired keyframe NAMES. now-playing-pulse is declared twice (home
// PosterCard + browse PosterCell), so the run's "seven keyframes to delete"
// counts DECLARATION SITES, not names. Both numbers are reported below.
const RETIRED_KEYFRAMES = [
  'now-playing-pulse',
  'sidebar-scan-pulse',
  'loombre-pulse',
  'loombre-settings-pulse',
  'loombre-hub-pulse',
  'loombre-stash-sync-pulse',
];

const PAINTED_TOKENS = ['--mono-xs', '--mono-sm'];

// Sub-12px literals: 0-9.xx px and 10/11(.xx)px. 12px and up is out of scope.
const SUBTWELVE_RE = /font-size:\s*(\d|1[01])(\.\d+)?px/;

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.turbo']);

function walkCss(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkCss(full, out);
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

// Blank out /* ... */ comment bodies while preserving newlines, so line numbers
// stay exact and commented-out / prototype-transcription lines never count.
// (MobileTabBar.module.css:57 quotes `font-size:10px` inside a prose comment —
// counting it would report 10 literals where 9 declarations exist.)
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const files = walkCss(SCAN_ROOT).sort();

const keyframes = new Map(
  RETIRED_KEYFRAMES.map((n) => [n, { declarations: [], consumers: [] }]),
);
const painted = new Map(PAINTED_TOKENS.map((t) => [t, []]));
const literals = [];

for (const file of files) {
  const rel = relative(REPO_ROOT, file).split(sep).join('/');
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');

  lines.forEach((line, i) => {
    const site = { file: rel, line: i + 1, text: line.trim() };

    for (const name of RETIRED_KEYFRAMES) {
      // Word-boundary-ish guard: loombre-pulse must not swallow
      // loombre-settings-pulse / loombre-hub-pulse / loombre-stash-sync-pulse.
      const boundary = String.raw`(?![\w-])`;
      if (new RegExp(String.raw`@keyframes\s+${name}${boundary}`).test(line)) {
        keyframes.get(name).declarations.push(site);
      }
      if (new RegExp(String.raw`animation[^:]*:[^;]*\b${name}${boundary}`).test(line)) {
        keyframes.get(name).consumers.push(site);
      }
    }

    for (const token of PAINTED_TOKENS) {
      if (line.includes(`var(${token})`)) painted.get(token).push(site);
    }

    if (SUBTWELVE_RE.test(line)) literals.push(site);
  });
}

const result = {
  scannedAt: new Date().toISOString(),
  scanRoot: relative(REPO_ROOT, SCAN_ROOT).split(sep).join('/'),
  cssFilesScanned: files.length,
  keyframes: Object.fromEntries(
    RETIRED_KEYFRAMES.map((n) => [
      n,
      {
        declarations: keyframes.get(n).declarations.length,
        consumers: keyframes.get(n).consumers.length,
        declarationSites: keyframes.get(n).declarations,
        consumerSites: keyframes.get(n).consumers,
      },
    ]),
  ),
  keyframeTotals: {
    names: RETIRED_KEYFRAMES.length,
    declarations: RETIRED_KEYFRAMES.reduce(
      (a, n) => a + keyframes.get(n).declarations.length, 0),
    consumers: RETIRED_KEYFRAMES.reduce(
      (a, n) => a + keyframes.get(n).consumers.length, 0),
  },
  painted: Object.fromEntries(
    PAINTED_TOKENS.map((t) => [
      t,
      { declarations: painted.get(t).length, sites: painted.get(t) },
    ]),
  ),
  paintedTotal: PAINTED_TOKENS.reduce((a, t) => a + painted.get(t).length, 0),
  subTwelvePxLiterals: { declarations: literals.length, sites: literals },
};

const args = new Set(process.argv.slice(2));

if (args.has('--json')) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
const out = [];

out.push('UI-AUDIT CENSUS — run UIFIX-2026-08-29');
out.push(`scanned: ${result.scanRoot}/**/*.css  (${result.cssFilesScanned} files)`);
out.push(`at:      ${result.scannedAt}`);
out.push('');
out.push('(a) RETIRED KEYFRAMES  — F3, deleted across lanes 0/A/B/E/H');
out.push(`  ${pad('name', 26)} ${num('@keyframes', 10)} ${num('consumers', 10)}`);
out.push(`  ${'-'.repeat(26)} ${'-'.repeat(10)} ${'-'.repeat(10)}`);
for (const name of RETIRED_KEYFRAMES) {
  const k = result.keyframes[name];
  out.push(`  ${pad(name, 26)} ${num(k.declarations, 10)} ${num(k.consumers, 10)}`);
}
out.push(`  ${pad('TOTAL', 26)} ${num(result.keyframeTotals.declarations, 10)} ${num(result.keyframeTotals.consumers, 10)}`);
out.push(`  (${result.keyframeTotals.names} names, ${result.keyframeTotals.declarations} declaration sites — now-playing-pulse is declared twice)`);
out.push('');
out.push('(b) PAINTED MONO TOKENS — G3 sweep surface (W2-B)');
out.push(`  ${pad('token', 26)} ${num('declarations', 14)}`);
out.push(`  ${'-'.repeat(26)} ${'-'.repeat(14)}`);
for (const token of PAINTED_TOKENS) {
  out.push(`  ${pad(`var(${token})`, 26)} ${num(result.painted[token].declarations, 14)}`);
}
out.push(`  ${pad('TOTAL', 26)} ${num(result.paintedTotal, 14)}`);
out.push('');
out.push('(c) HARDCODED SUB-12px font-size LITERALS — G3 sweep surface (W2-B)');
out.push(`  ${pad('file:line', 60)} ${'declaration'}`);
out.push(`  ${'-'.repeat(60)} ${'-'.repeat(20)}`);
for (const s of literals) {
  out.push(`  ${pad(`${s.file}:${s.line}`, 60)} ${s.text}`);
}
out.push(`  TOTAL: ${result.subTwelvePxLiterals.declarations}`);
out.push('');
out.push('NOTE: comment bodies are blanked before matching, so prose that quotes');
out.push('a size (e.g. MobileTabBar.module.css:57) never inflates a count.');

if (args.has('--sites')) {
  out.push('');
  out.push('--- SITES ---');
  for (const name of RETIRED_KEYFRAMES) {
    const k = result.keyframes[name];
    out.push(`${name}:`);
    for (const s of k.declarationSites) out.push(`  @keyframes  ${s.file}:${s.line}`);
    for (const s of k.consumerSites) out.push(`  animation   ${s.file}:${s.line}  ${s.text}`);
  }
  for (const token of PAINTED_TOKENS) {
    out.push(`var(${token}):`);
    for (const s of result.painted[token].sites) out.push(`  ${s.file}:${s.line}  ${s.text}`);
  }
}

process.stdout.write(`${out.join('\n')}\n`);
process.exit(0);
