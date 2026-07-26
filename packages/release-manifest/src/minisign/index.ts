// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/release-manifest/src/minisign/index.ts — subpackage barrel.

export type {
  MinisignPublicKey,
  ManifestVerificationFailureReason,
  ManifestVerificationResult,
} from "./types.js";
export { MANIFEST_VERIFICATION_FAILURE_REASONS } from "./types.js";

export type {
  ParsedPublicKey,
  ParsedSignatureFile,
  ParsedSignatureFileValue,
} from "./parse.js";
export { parseMinisignPublicKey, parseMinisignSignatureFile } from "./parse.js";

export { verifyManifestSignature } from "./verify.js";
