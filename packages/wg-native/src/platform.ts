// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/src/platform.ts
//
// The ONE other place (besides scripts/build.mjs) that knows the built
// artifact's naming scheme — kept intentionally tiny and dependency-free so
// both the build script and the runtime loader can never drift apart on
// what file they mean by "the current platform's library". Both the
// compiled loader (dist/loader.js, via tsc) and the Go build script's
// output land in the SAME dist/ directory, so resolution is a plain
// sibling-file join — no package-root walk needed.

import { join } from "node:path";

function platformExt(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "dylib";
  if (platform === "win32") return "dll";
  return "so";
}

export function artifactName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `wg-native-${platform}-${arch}.${platformExt(platform)}`;
}

/** dist/ lives at the package root, sibling to the compiled loader itself
 *  — resolveLibraryPath(distDir) just joins the artifact's own name onto
 *  whatever directory the caller already knows is "dist" (loader.ts passes
 *  its own dirname; tests can pass an arbitrary fixture directory). */
export function resolveLibraryPath(distDir: string): string {
  return join(distDir, artifactName());
}
