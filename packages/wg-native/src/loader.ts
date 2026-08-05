// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/src/loader.ts
//
// koffi FFI bindings over dist/wg-native-<platform>-<arch>.<ext> (built by
// scripts/build.mjs from native/, see that package's main.go header for the
// exported C API this file declares).
//
// EVERY call goes through koffi's `.async()` worker-thread mode — NEVER a
// synchronous call. This is not a style preference: a synchronous koffi
// call was PROVEN (this lane's dedicated debugging session; see native/
// testclient.go's WgTestClientFetch doc comment and STATE.md's WG1 report)
// to starve wireguard-go's own background goroutines for the full duration
// of any call doing real network I/O — the WG handshake would complete but
// no transport data would move until the call's own timeout forced a
// teardown-triggered flush. koffi's async mode runs the FFI call on a
// libuv worker thread instead, which resolved it completely. This applies
// to every exported function here, not just the one that does obvious
// network I/O (WgStart/WgStop spawn/tear down long-lived goroutines a
// synchronous call could equally starve).
//
// Every returned string is a koffi "disposable" type wrapping WgFreeString
// — the native library's own free function (C.CString-allocated memory
// must be freed by the SAME allocator that made it, never koffi.free /
// libc free directly, which could be a different CRT on Windows — see
// native/envelope.go's header). koffi calls WgFreeString automatically
// once each returned string has been copied into a JS string, so no call
// site here ever manages that pointer directly.

import koffi from "koffi";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLibraryPath } from "./platform.js";

/** dist/ is always a SIBLING of src/, both directly under the package
 *  root — true whether this module is running compiled (dist/loader.js,
 *  sits IN dist/ already) or straight from source (src/loader.ts, e.g.
 *  vitest transforming TS on the fly without going through tsc's outDir).
 *  Walking up one level only when the current directory is actually named
 *  "src" keeps both cases resolving to the SAME packages/wg-native/dist/. */
function defaultDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(here) === "src" ? join(dirname(here), "dist") : here;
}

export interface WgEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Thrown when a wg-native call's envelope reports ok:false — callers that
 *  want the raw envelope instead (e.g. to distinguish error kinds without a
 *  try/catch) should use the `*Raw` functions client.ts builds on instead. */
export class WgNativeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WgNativeError";
  }
}

export interface WgNativeLibrary {
  wgStart(configJSON: string): Promise<string>;
  wgStop(instanceId: string): Promise<string>;
  wgAddPeer(instanceId: string, peerJSON: string): Promise<string>;
  wgRemovePeer(instanceId: string, publicKeyBase64: string): Promise<string>;
  wgStatus(instanceId: string): Promise<string>;
  wgTestClientFetch(clientConfigJSON: string, url: string): Promise<string>;
}

let cached: { path: string; lib: WgNativeLibrary } | undefined;

/** Attempts to load the native library for the CURRENT platform/arch —
 *  returns undefined (never throws) when the file doesn't exist, matching
 *  every other "graceful, detect-and-skip" resolver in this repo
 *  (apps/worker/src/probe/ffprobe.ts's resolveFfmpeg). test/support/
 *  require-wg.ts is the ONE place that turns "unavailable" into a hard
 *  failure, gated by LOOMBRE_REQUIRE_WG. */
export function tryLoadWgNative(distDir?: string): WgNativeLibrary | undefined {
  const dir = distDir ?? defaultDistDir();
  const libPath = resolveLibraryPath(dir);

  if (cached && cached.path === libPath) return cached.lib;

  let raw: ReturnType<typeof koffi.load>;
  try {
    raw = koffi.load(libPath);
  } catch {
    return undefined;
  }

  const wgFreeRaw = raw.func("void WgFreeString(void *ptr)");
  // A NAMED disposable type (koffi.dispose docs: an anonymous disposable
  // "cannot be used in function prototypes" — the string-prototype
  // declarations below need a name to reference). Registers "WgHeapStr" as
  // a type usable in this koffi instance: koffi copies the C string into a
  // JS string, then calls wgFreeRaw(originalPointer) — routing the free
  // through THIS library's own allocator, never koffi.free/libc free
  // (native/main.go's header: a different CRT on Windows could own libc's
  // free, which would be undefined behavior against Go's C.CString memory).
  koffi.disposable("WgHeapStr", "str", wgFreeRaw);

  const wgStartRaw = raw.func("WgHeapStr WgStart(const char *configJson)");
  const wgStopRaw = raw.func("WgHeapStr WgStop(const char *instanceId)");
  const wgAddPeerRaw = raw.func("WgHeapStr WgAddPeer(const char *instanceId, const char *peerJson)");
  const wgRemovePeerRaw = raw.func("WgHeapStr WgRemovePeer(const char *instanceId, const char *publicKey)");
  const wgStatusRaw = raw.func("WgHeapStr WgStatus(const char *instanceId)");
  const wgTestClientFetchRaw = raw.func("WgHeapStr WgTestClientFetch(const char *clientConfigJson, const char *url)");

  // koffi's own .d.ts types every `.async` member as `(...args: any[]) =>
  // any` (it cannot know a given native function's real arity/types) — the
  // casts below are this module's ONE place that re-attaches the real
  // shapes documented in native/main.go's header, so every OTHER file in
  // this package sees a properly typed WgNativeLibrary.
  const lib: WgNativeLibrary = {
    wgStart: promisify(wgStartRaw.async) as (configJSON: string) => Promise<string>,
    wgStop: promisify(wgStopRaw.async) as (instanceId: string) => Promise<string>,
    wgAddPeer: promisify(wgAddPeerRaw.async) as (instanceId: string, peerJSON: string) => Promise<string>,
    wgRemovePeer: promisify(wgRemovePeerRaw.async) as (instanceId: string, publicKeyBase64: string) => Promise<string>,
    wgStatus: promisify(wgStatusRaw.async) as (instanceId: string) => Promise<string>,
    wgTestClientFetch: promisify(wgTestClientFetchRaw.async) as (clientConfigJSON: string, url: string) => Promise<string>,
  };

  cached = { path: libPath, lib };
  return lib;
}

/** Parses a wg-native JSON envelope and throws WgNativeError on ok:false —
 *  the shape every client.ts method builds on. */
export function parseEnvelope<T>(raw: string): T {
  let envelope: WgEnvelope<T>;
  try {
    envelope = JSON.parse(raw) as WgEnvelope<T>;
  } catch (err) {
    throw new WgNativeError(`wg-native returned invalid JSON: ${String(err)}`);
  }
  if (!envelope.ok) {
    throw new WgNativeError(envelope.error ?? "wg-native call failed with no error message");
  }
  return envelope.data as T;
}

/** Test-only seam: forces the next tryLoadWgNative() call to re-resolve
 *  instead of returning the cached instance — used by fixture-directory
 *  tests that load a DIFFERENT dist/ than the package's own. */
export function resetWgNativeCacheForTests(): void {
  cached = undefined;
}
