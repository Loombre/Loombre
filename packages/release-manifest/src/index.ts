// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/release-manifest/src/index.ts — public package barrel.

export { MANIFEST_FILENAME, MANIFEST_SIGNATURE_FILENAME } from "./filenames.js";

export {
  RELEASE_MANIFEST_VERSION,
  RELEASE_CHANNELS,
  ARTIFACT_PLATFORMS,
  ARTIFACT_KINDS,
  RELEASE_ARTIFACT_SCHEMA,
  RELEASE_ENTRY_SCHEMA,
  RELEASE_MANIFEST_SCHEMA,
} from "./manifest.js";
export type {
  ReleaseChannel,
  ArtifactPlatform,
  ArtifactKind,
  ReleaseArtifact,
  ReleaseEntry,
  ReleaseManifest,
} from "./manifest.js";

export * from "./minisign/index.js";
