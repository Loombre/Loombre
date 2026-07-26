// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/support/require-pebble.ts
//
// Same posture as apps/worker/test/support/require-ffmpeg.ts (Phase 3
// step 7's lesson: a silent skip can masquerade as a green run forever).
// The pebble ACME integration suites need a real `docker compose -f
// apps/server/test/tls/pebble/docker-compose.yml up -d` running first —
// that's real infrastructure this repo's default `pnpm gate` must NOT
// depend on (most environments won't have it up), so the default posture
// is a graceful, LOUD skip. LOOMBRE_REQUIRE_PEBBLE=1 escalates an
// unreachable pebble to a hard failure for CI legs / owner runs that are
// SUPPOSED to have it up, so a misconfigured runner can never silently
// report this suite as "0 tests, fine" again.

const PEBBLE_DIRECTORY_URL = process.env["LOOMBRE_TEST_PEBBLE_DIRECTORY_URL"] ?? "https://127.0.0.1:3600/dir";
const CHALLTESTSRV_URL = process.env["LOOMBRE_TEST_CHALLTESTSRV_URL"] ?? "http://127.0.0.1:3602";

async function reachable(url: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Pebble's own TLS cert is self-signed (test CA) — the whole point of
    // this reachability probe is "is something listening and speaking
    // HTTP(S) here", not "is its chain trusted", so this fetch call uses
    // Node's global dispatcher default (no custom agent) and only cares
    // about getting ANY response back, including a TLS/cert error thrown
    // as a rejected promise — see the catch below.
    await fetch(url, { signal: controller.signal });
    return true;
  } catch (err) {
    // A self-signed-cert rejection still proves "something is listening
    // and spoke TLS back" — that's reachability, just not trust. Node's
    // fetch throws a generic `TypeError: fetch failed` whose real reason
    // lives on `.cause` (confirmed empirically: a plain `.message` check
    // never sees the actual "unable to verify the first certificate"
    // string) — anything else (ECONNREFUSED, abort/timeout) is a real
    // "not reachable".
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    const message = cause instanceof Error ? cause.message : String(cause);
    return /certificate|self.signed|unable to verify/i.test(message);
  } finally {
    clearTimeout(timer);
  }
}

export async function pebbleAvailable(): Promise<boolean> {
  const [pebbleOk, challtestsrvOk] = await Promise.all([
    reachable(PEBBLE_DIRECTORY_URL),
    reachable(CHALLTESTSRV_URL),
  ]);
  const ok = pebbleOk && challtestsrvOk;
  if (!ok && process.env["LOOMBRE_REQUIRE_PEBBLE"]) {
    throw new Error(
      "LOOMBRE_REQUIRE_PEBBLE is set but pebble/challtestsrv are not reachable " +
        `(pebble ${PEBBLE_DIRECTORY_URL}: ${pebbleOk ? "up" : "down"}, challtestsrv ${CHALLTESTSRV_URL}: ${challtestsrvOk ? "up" : "down"}) — ` +
        "refusing to silently skip the pebble ACME integration suite. " +
        "Bring it up with: docker compose -f apps/server/test/tls/pebble/docker-compose.yml up -d",
    );
  }
  return ok;
}
