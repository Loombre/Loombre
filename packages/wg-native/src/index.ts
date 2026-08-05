// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/src/index.ts
//
// Public barrel. apps/server/src/remote/wireguard (and this package's own
// tests) import from here, never from loader.ts/platform.ts directly.

export {
  WgNativeClient,
  type WgPeerConfig,
  type WgStartConfig,
  type WgPeerStatus,
  type WgStatusResult,
  type WgTestClientConfig,
  type WgFetchResult,
} from "./client.js";

export { WgNativeError, tryLoadWgNative } from "./loader.js";

export { generateWgKeyPair, derivePublicKey, isValidWgKey, type WgKeyPair } from "./keys.js";

export { artifactName, resolveLibraryPath } from "./platform.js";
