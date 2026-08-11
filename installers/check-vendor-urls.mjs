#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/check-vendor-urls.mjs
//
// Task #16 — daily liveness probe for the vendored ffmpeg/ffprobe archives
// installers/ffmpeg-manifest.json pins, PLUS a check that this repo's own
// private `ffmpeg-mirror` GitHub release (the manifest's top-level
// `mirror` block) actually holds the derived asset name for every one of
// them. Exists so an upstream deletion (BtbN garbage-collects releases —
// it deleted our pinned autobuild mid-rc.7-draft, see d3a6883d) or a stale/
// missing mirror asset is caught by CI on a schedule, before a release
// build needs scripts/fetch-ffmpeg.mjs's fallback for real.
//
// Usage:
//   node installers/check-vendor-urls.mjs [--manifest <path>]
//
// Probe method: HEAD first (cheap — no body transferred); if that throws
// or comes back 405 Method Not Allowed, retries with GET + a
// `Range: bytes=0-0` header (fetches at most one byte). Empirically, every
// URL this manifest currently pins (BtbN/GitHub releases, evermeet.cx,
// osxexperts.net) answers HEAD directly with a normal 200 after following
// its redirect chain — no live 405 was observed while building this check
// (see the Task #16 report for the actual probe transcript) — but GitHub's
// release-asset redirect target is a storage host outside this repo's
// control, so the GET+Range fallback stays in as a safety net rather than
// being cut for being currently unexercised.
//
// Mirror-asset check: the mirror repo is PRIVATE, so this needs a GitHub
// token (GITHUB_TOKEN, else GH_TOKEN — same resolution as
// scripts/fetch-ffmpeg.mjs's own fallback, imported from there so the two
// never disagree). No token -> that half of the check is SKIPPED WITH A
// NOTICE (printed, not silent) rather than failing the whole run — a
// developer running this locally without a token still gets the URL-
// liveness half; .github/workflows/vendor-liveness.yml always supplies one.
//
// Exit code: 0 iff every URL answers AND (when a token is available) every
// derived mirror asset name is present. Nonzero on ANY miss, with a
// per-URL/per-asset report printed either way (not just on failure) so a
// green run is also legible.
//
// Dependency-free, matching scripts/fetch-ffmpeg.mjs's own posture (this
// repo's lockfile stays frozen for the installers/scripts lane) — global
// fetch (Node >=24, this repo's engines floor) is all either script needs.

import { pathToFileURL } from "node:url";

import {
  loadManifest,
  planDownloads,
  deriveMirrorAssetName,
  resolveGithubToken,
  fetchMirrorReleaseAssets,
  DEFAULT_MANIFEST_PATH,
} from "../scripts/fetch-ffmpeg.mjs";

// ─────────────────────────────────────────────────────────────────────────
// Pure functions — no filesystem, no network. Unit-tested in
// installers/check-vendor-urls.test.mjs.
// ─────────────────────────────────────────────────────────────────────────

/** Pure CLI arg parser — mirrors scripts/fetch-ffmpeg.mjs's parseArgs
 *  style (no process.exit, no I/O). */
export function parseArgs(argv) {
  const out = { manifestPath: DEFAULT_MANIFEST_PATH, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest") out.manifestPath = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`check-vendor-urls: unrecognized argument ${JSON.stringify(arg)}`);
  }
  return out;
}

/**
 * Flattens every platform's downloads (via scripts/fetch-ffmpeg.mjs's own
 * planDownloads — imported, not reimplemented, so the two scripts can
 * never disagree about what "one archive" means for a platform whose
 * ffmpeg+ffprobe components share a single url+sha256) into ONE list,
 * deduped a second time ACROSS platforms by url+sha256. No two platforms
 * share an archive today, but the dedup is free and keeps this correct if
 * that ever changes. Each returned entry also records which platform(s)
 * wanted it, for a readable report. Pure — operates on the already-parsed
 * manifest only.
 */
export function collectUniqueComponents(manifest) {
  const seen = new Map();
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    for (const download of planDownloads(entry)) {
      const key = `${download.url}::${download.sha256}`;
      if (!seen.has(key)) {
        seen.set(key, { url: download.url, sha256: download.sha256, format: download.format, platforms: [] });
      }
      seen.get(key).platforms.push(platform);
    }
  }
  return [...seen.values()];
}

// ─────────────────────────────────────────────────────────────────────────
// I/O — network probes + the CLI entrypoint.
// ─────────────────────────────────────────────────────────────────────────

/** Cheap existence probe for one archive URL: HEAD first, falling back to
 *  GET + `Range: bytes=0-0` (at most one byte transferred) if HEAD throws
 *  or answers 405 — see this file's header for what was empirically
 *  observed against the real pinned URLs. `fetchImpl` is injectable so
 *  installers/check-vendor-urls.test.mjs can exercise both branches
 *  without any real network access. */
export async function probeUrl(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const userAgent = { "user-agent": "loombre-check-vendor-urls" };
  try {
    const res = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
      headers: userAgent,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 405) {
      return { ok: res.ok, status: res.status, method: "HEAD" };
    }
  } catch {
    // HEAD unsupported/rejected at the network level — fall through to the
    // GET+Range probe below rather than reporting a false miss.
  }
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: { ...userAgent, Range: "bytes=0-0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the (at most one byte) body — an unconsumed response stream
    // keeps the underlying connection open until GC, which fetch/undici
    // warns about under repeated use (this script probes several URLs per
    // run).
    if (res.body) await res.arrayBuffer();
    return { ok: res.ok, status: res.status, method: "GET+Range" };
  } catch (err) {
    return { ok: false, status: null, method: "GET+Range", error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: node installers/check-vendor-urls.mjs [--manifest <path>]");
    return 0;
  }

  const manifest = loadManifest(args.manifestPath);
  const components = collectUniqueComponents(manifest);

  console.log(`check-vendor-urls: probing ${components.length} unique archive URL(s) pinned by ${args.manifestPath}`);

  let failures = 0;
  for (const component of components) {
    const result = await probeUrl(component.url);
    const platforms = component.platforms.join(", ");
    if (result.ok) {
      console.log(`  OK   [${result.method} ${result.status}] ${component.url} (${platforms})`);
    } else {
      failures += 1;
      const reason = result.error ? `error: ${result.error}` : `HTTP ${result.status}`;
      console.error(`  MISS [${result.method} ${reason}] ${component.url} (${platforms})`);
    }
  }

  let mirrorChecked = false;
  if (!manifest.mirror) {
    console.log('check-vendor-urls: manifest has no "mirror" block — skipping the mirror-asset check.');
  } else {
    const token = resolveGithubToken();
    if (!token) {
      console.log(
        `check-vendor-urls: no GitHub token available (set GITHUB_TOKEN or GH_TOKEN) — skipping the ` +
          `${manifest.mirror.repo}#${manifest.mirror.releaseTag} mirror-asset check (the mirror repo is private, ` +
          `so an unauthenticated call cannot see its assets).`,
      );
    } else {
      mirrorChecked = true;
      console.log(`check-vendor-urls: checking ${manifest.mirror.repo}#${manifest.mirror.releaseTag} for every derived asset name...`);
      let assetNames = new Set();
      try {
        const assets = await fetchMirrorReleaseAssets(manifest.mirror, token);
        assetNames = new Set(assets.map((asset) => asset.name));
      } catch (err) {
        failures += 1;
        console.error(
          `  MISS [mirror] could not list ${manifest.mirror.repo}#${manifest.mirror.releaseTag}'s assets: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      for (const component of components) {
        const expectedName = deriveMirrorAssetName(component.sha256, component.url);
        const platforms = component.platforms.join(", ");
        if (assetNames.has(expectedName)) {
          console.log(`  OK   [mirror] ${expectedName} (${platforms})`);
        } else {
          failures += 1;
          console.error(`  MISS [mirror] ${expectedName} not found in the mirror release (${platforms})`);
        }
      }
    }
  }

  if (failures > 0) {
    console.error(`check-vendor-urls: FAIL — ${failures} miss(es) reported above.`);
    return 1;
  }
  console.log(
    mirrorChecked
      ? "check-vendor-urls: PASS — every pinned URL answers and every mirror asset is present."
      : "check-vendor-urls: PASS — every pinned URL answers (mirror-asset check was skipped — see notice above).",
  );
  return 0;
}

const isDirectEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntrypoint) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
