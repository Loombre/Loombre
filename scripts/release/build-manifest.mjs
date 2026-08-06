#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/build-manifest.mjs
//
// Builds + validates dist/release/manifest.json from the artifacts
// build-linux/build-windows/build-macos/build-docker staged into
// --artifacts-dir (.github/workflows/release.yml's shared contract — see
// the release-lane report's "what release.yml needs from lanes I1-I4"
// section for the exact filename convention every installer script must
// follow: `loombre-<version>-<platform>.<ext>`).
//
// Usage:
//   node scripts/release/build-manifest.mjs \
//     --version 0.9.0 \
//     --notes-url https://github.com/<owner>/<repo>/releases/tag/v0.9.0 \
//     --artifacts-dir dist/release \
//     --base-url https://github.com/<owner>/<repo>/releases/download/v0.9.0 \
//     --out dist/release/manifest.json
//
// The Docker image artifacts (no local file to hash — they live in a
// registry) are picked up from sidecar files in --artifacts-dir if
// present: `docker-image.json` for the server image and
// `docker-web-image.json` for the web image, each `{ "filename": "...",
// "sizeBytes": N, "sha256": "<64 hex, the image digest without the
// 'sha256:' prefix>", "url": "..." }` — build-docker's job in
// release.yml writes both after `cosign sign`. Both sidecars are build
// INPUTS, not release artifacts themselves (AUD-A5c-002): once a
// sidecar's data is folded into a manifest.json that has actually been
// written to --out, this script deletes the sidecar from --artifacts-dir
// so it can't also end up checksummed into SHA256SUMS-after-this-step or
// published as a literal GitHub Release download asset. The delete is
// deliberately ordered after the write, not at read time — see
// deleteConsumedDockerSidecars's comment below for why a run that fails
// before writing manifest.json must not have already consumed the
// sidecars a retry needs.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildManifest, buildDockerArtifacts, DOCKER_SIDECAR_FILES, inferPlatformAndKind, validateManifestShape } from "./lib/build-manifest-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`build-manifest: missing value for --${key}`);
      }
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

function sha256File(filePath) {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

export function collectFileArtifacts(artifactsDir, baseUrl) {
  const artifacts = [];
  for (const entry of readdirSync(artifactsDir)) {
    // Explicit allow-list of NON-artifact files that legitimately sit in
    // dist/release. Anything else must be a real artifact — see the throw
    // below for why this list is exhaustive rather than a prefix match.
    // The Docker sidecars are named via DOCKER_SIDECAR_FILES (not
    // hardcoded here) so adding a sidecar to that one array also updates
    // this skip-list — see its doc comment in build-manifest-lib.mjs for
    // the other place (sha256sums.mjs's EXCLUDED_FILES) that array does
    // NOT reach.
    if (
      DOCKER_SIDECAR_FILES.includes(entry) ||
      entry.endsWith(".minisig") ||
      entry === "SHA256SUMS" ||
      entry === "manifest.json"
    ) {
      continue;
    }
    const full = path.join(artifactsDir, entry);
    if (!statSync(full).isFile()) continue;

    const inferred = inferPlatformAndKind(entry);
    if (!inferred) {
      // FAIL, not warn. This was a console.warn, and it cost the rc.2
      // release its bootstrapper: the new .exe had no EXTENSION_TO_KIND
      // entry, so it was skipped with a warning nobody read, and shipped
      // in SHA256SUMS (which globs the directory) but NOT in the signed
      // manifest.json that a download page or updater reads. A release
      // artifact that the pipeline does not understand is a release
      // problem, not a log line.
      throw new Error(
        `build-manifest: ${entry} is in the release directory but does not match the ` +
          `loombre-<version>-<platform>.<ext> convention with a known extension. ` +
          `If it is a new artifact type, add its extension to EXTENSION_TO_KIND (and its kind to ` +
          `ARTIFACT_KINDS in packages/release-manifest). If it is not an artifact, add it to the ` +
          `skip list above. Refusing to publish a manifest that silently omits it.`,
      );
    }

    artifacts.push({
      platform: inferred.platform,
      kind: inferred.kind,
      filename: entry,
      sizeBytes: statSync(full).size,
      sha256: sha256File(full),
      url: `${baseUrl.replace(/\/+$/, "")}/${entry}`,
    });
  }
  return artifacts;
}

/**
 * Reads (but does NOT delete) whichever Docker sidecars are present in
 * --artifacts-dir. Deletion is a separate step (deleteConsumedDockerSidecars
 * below) that main() only calls once manifest.json has actually been
 * written — see that function's comment for why collecting and consuming
 * used to be one non-idempotent step and what that broke.
 *
 * @param {string} artifactsDir
 * @returns {{ artifacts: ReturnType<typeof buildDockerArtifacts>, consumedFiles: string[] }}
 *   consumedFiles is the subset of DOCKER_SIDECAR_FILES that was actually
 *   found and read — the exact list a caller must pass to
 *   deleteConsumedDockerSidecars once it is safe to do so.
 */
export function collectDockerArtifacts(artifactsDir) {
  const sidecarsByFile = {};
  for (const file of DOCKER_SIDECAR_FILES) {
    const sidecarPath = path.join(artifactsDir, file);
    if (!existsSync(sidecarPath)) continue;
    sidecarsByFile[file] = JSON.parse(readFileSync(sidecarPath, "utf8"));
  }
  return { artifacts: buildDockerArtifacts(sidecarsByFile), consumedFiles: Object.keys(sidecarsByFile) };
}

/**
 * Deletes the Docker sidecars collectDockerArtifacts read, once (and only
 * once) they are safely folded into a manifest.json that has actually been
 * written to disk — see the header + AUD-A5c-002: a consumed sidecar must
 * never survive to be published as a literal release asset (previously
 * only docker-image.json got this treatment, via a separate `rm -f` step
 * in release.yml; docker-web-image.json had no equivalent and was
 * shipping as a real download).
 *
 * Deliberately NOT folded into collectDockerArtifacts: that used to
 * unlink each sidecar the moment it was read, so ANY failure between
 * reading it and writing the manifest (an unrecognized file elsewhere in
 * --artifacts-dir, a schema-validation error, a disk-full write) left the
 * sidecar deleted with no manifest ever written — a retry against the
 * same --artifacts-dir would then silently produce a manifest missing the
 * Docker images, the exact AUD-A5c-001 silent-omission class this
 * script's unrecognized-file throw exists to prevent elsewhere. Ordering
 * the delete after a confirmed-successful write closes that gap: a run
 * that doesn't reach main()'s writeFileSync leaves the sidecars intact,
 * so collectDockerArtifacts on a retry finds the same files and returns
 * the same artifacts (see build-manifest-cli.test.mjs's "leaves the
 * sidecars intact for a retry" case). A run that DID fully succeed
 * legitimately consumes them — a later invocation against that same,
 * now-published directory has no sidecars left to fold in, by design.
 *
 * @param {string} artifactsDir
 * @param {string[]} consumedFiles
 */
export function deleteConsumedDockerSidecars(artifactsDir, consumedFiles) {
  for (const file of consumedFiles) {
    unlinkSync(path.join(artifactsDir, file));
  }
}

export function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["version", "notes-url", "artifacts-dir", "base-url", "out"]) {
    if (!args[required]) {
      console.error(`build-manifest: missing required --${required}`);
      process.exit(1);
    }
  }

  const artifactsDir = path.isAbsolute(args["artifacts-dir"])
    ? args["artifacts-dir"]
    : path.join(REPO_ROOT, args["artifacts-dir"]);

  const artifacts = collectFileArtifacts(artifactsDir, args["base-url"]);
  const { artifacts: dockerArtifacts, consumedFiles: dockerSidecarFiles } = collectDockerArtifacts(artifactsDir);
  artifacts.push(...dockerArtifacts);

  if (artifacts.length === 0) {
    console.error(`build-manifest: no artifacts found in ${artifactsDir} — refusing to write an empty manifest`);
    process.exit(1);
  }

  const manifest = buildManifest({
    version: args.version,
    releasedAtMs: Date.now(),
    notesUrl: args["notes-url"],
    artifacts,
  });

  const errors = validateManifestShape(manifest);
  if (errors.length > 0) {
    console.error(`build-manifest: manifest failed schema validation (${errors.length} error(s)):`);
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  const outPath = path.isAbsolute(args.out) ? args.out : path.join(REPO_ROOT, args.out);
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // Only NOW that the manifest is durably written do we consume the
  // sidecars — see deleteConsumedDockerSidecars's comment for why this is
  // not folded into collectDockerArtifacts above.
  deleteConsumedDockerSidecars(artifactsDir, dockerSidecarFiles);
  console.log(`build-manifest: wrote ${path.relative(REPO_ROOT, outPath)} — ${artifacts.length} artifact(s), version ${args.version}`);
}

// Guarded so scripts/release/test/build-manifest-cli.test.mjs can import
// this module's fs-touching functions (collectFileArtifacts,
// collectDockerArtifacts, deleteConsumedDockerSidecars) directly, against
// real temp-dir fixtures, without `main()` also running against the test
// runner's own argv (same pattern as scripts/fetch-embedded-pg.mjs's
// isDirectEntrypoint guard).
const isDirectEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntrypoint) {
  main();
}
