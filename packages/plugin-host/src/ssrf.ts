// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/src/ssrf.ts
//
// LD5: the SSRF guard every outbound plugin call passes through (manifest
// fetch, capability calls, event delivery — this file's `hardenedFetch` is
// the SOLE network-issuing primitive in this package; nothing else in
// packages/plugin-host calls the platform `fetch` directly). Rules:
//
//   - http/https schemes only.
//   - Hostname resolution: an IP-literal hostname is parsed directly; a
//     DNS name is resolved via `dns.lookup(hostname, { all: true })`
//     (all addresses, not just the first) and EVERY returned address is
//     checked — a hostname that resolves to even ONE disallowed address is
//     rejected wholesale, because which address a real connection actually
//     dials is not under this module's control (the platform fetch/DNS
//     stack picks one, and that choice can vary between calls).
//   - Disallowed ranges (unless the exact hostname/IP literal appears in
//     the caller-supplied `lanAllowlist`): loopback, private (10/8,
//     172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), ULA
//     (fc00::/7), multicast, broadcast (255.255.255.255), unspecified
//     (0.0.0.0, ::).
//   - `redirect: 'manual'` always — ANY 3xx response is a typed failure,
//     never followed. A plugin that wants to move must update its
//     registered base_url through re-registration, not via a redirect this
//     guard would otherwise have to re-validate recursively.
//   - Every call carries a hard AbortSignal timeout (caller-supplied).
//   - The response body is read in capped chunks (caller-supplied byte
//     cap) — a response that exceeds the cap aborts the underlying
//     connection immediately rather than buffering an unbounded body.
//
// DNS-REBINDING TOCTOU — CLOSED (fix wave, see resolveAndValidateHost/
// pinnedDialFetch below). Previously this module resolved and validated a
// hostname's address(es), THEN issued the fetch by URL (hostname) — a
// SECOND, independent resolution the platform fetch/getaddrinfo stack
// performs internally when actually dialing. A malicious/compromised DNS
// server answering the validation lookup with a public address and a
// SUBSEQUENT lookup with a private one (classic DNS rebinding) could slip
// a request past the guard entirely; the adversarial review re-assessed
// this residual as MEDIUM-HIGH (an unlimited retry budget — the delivery
// loop retries every 5s poll forever — turns a ~50% per-attempt race into
// a near-certainty within a minute).
//
// Fix: `resolveAndValidateHost` resolves + validates EXACTLY ONCE and
// returns the specific address it validated; `pinnedDialFetch` then dials
// THAT LITERAL ADDRESS directly (via `node:http`/`node:https`'s `request()`
// — no new dependency, this module already only needed the small slice of
// `fetch` it uses: method/headers/body in, status/headers/streamed body
// out), while still presenting the ORIGINAL hostname for the `Host` header
// and TLS SNI (`servername`) so a virtual-hosted/SNI-routed plugin server
// still works. Because the address handed to `http.request`/`https.request`
// is already a literal IP (never a hostname), Node's own connection layer
// never performs a SECOND DNS lookup at all — there is no second lookup
// left for an attacker to answer differently.
//
// RESIDUAL (still open, documented precisely, not a regression from
// before): the LAN-allowlist EXACT-HOSTNAME bypass (`lanAllowlist`
// containing the literal hostname string) is, by existing/tested contract,
// NEVER resolved by this module at all — the admin has already explicitly
// named and trusted that literal name, so there is no validated address to
// pin to, and the request dials via the platform's own (unpinned) DNS
// resolution, exactly as before this fix. This is the one case DNS
// rebinding remains theoretically possible after this fix, and it is
// unchanged risk (not worsened) versus the pre-fix behavior: an admin who
// allowlists a LAN hostname by name is already trusting that name's DNS
// answer, request by request, the same way any other client on the network
// would. Every OTHER path (a bare IP literal, or a DNS name NOT in the
// allowlist) is now pinned.
//
// M-5 fix wave (also fixed here): a bracketed IPv6 hostname
// (`URL.hostname` for `http://[::1]/` is the literal string `"[::1]"`,
// INCLUDING the brackets) used to bypass `isIP()` entirely, making the
// whole IPv6 disallow-list dead code for URL-derived literals (every IPv6
// literal fell through to the DNS-lookup branch and failed as
// `dns-resolution-failed`, never `disallowed-address`) — fails closed today
// (a latent bug, not a live hole) but would have opened direct loopback
// SSRF the instant someone "fixed" only the bracket-stripping half without
// also fixing the classifier below. `resolveAndValidateHost` strips
// brackets before calling `isIP`. The classifier itself
// (`isDisallowedIPv6Bytes`) now normalizes an IPv6 literal to its 16 raw
// bytes and classifies by BYTE PREFIX rather than string-matching — the
// previous classifier's IPv4-mapped detection was a regex for the DOTTED
// form only (`::ffff:a.b.c.d`), so the HEX form
// (`::ffff:7f00:1` — exactly what WHATWG `URL` normalizes
// `[::ffff:127.0.0.1]` to) classified as ALLOWED. Byte-prefix comparison
// catches both forms identically, plus NAT64 (`64:ff9b::/96`) and 6to4
// (`2002::/16`) embeddings, plus the deprecated IPv4-compatible (`::/96`)
// form, none of which the old classifier recognized at all.

import { isIP, isIPv4, isIPv6 } from "node:net";
import { lookup as dnsLookupCallback } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const nodeDnsLookup = promisify(dnsLookupCallback);

export type SsrfRejectionReason =
  | "unsupported-scheme"
  | "invalid-url"
  | "dns-resolution-failed"
  | "disallowed-address"
  | "redirect-not-followed"
  | "timeout"
  | "network-error"
  | "response-too-large";

export class HardenedFetchError extends Error {
  readonly reason: SsrfRejectionReason;
  readonly targetUrl: string;

  constructor(reason: SsrfRejectionReason, targetUrl: string, message?: string) {
    super(message ?? `hardenedFetch: ${reason} (${targetUrl})`);
    this.name = "HardenedFetchError";
    this.reason = reason;
    this.targetUrl = targetUrl;
  }
}

export interface DnsAddress {
  address: string;
  family: number;
}

export type DnsLookupFn = (hostname: string) => Promise<DnsAddress[]>;

/** Default DNS resolver: `node:dns`'s callback `lookup` with `{ all: true
 *  }`, promisified. Injectable (every hardenedFetch/callPlugin caller may
 *  supply its own) so tests never depend on real DNS. */
export const defaultDnsLookup: DnsLookupFn = async (hostname) => {
  const result = await nodeDnsLookup(hostname, { all: true });
  return result as DnsAddress[];
};

// ============================================================================
// address classification
// ============================================================================

function stripZoneId(address: string): string {
  const percentIndex = address.indexOf("%");
  return percentIndex === -1 ? address : address.slice(0, percentIndex);
}

/** Strips the `[`/`]` brackets `URL.hostname` puts around an IPv6 literal
 *  (M-5 fix wave) — a no-op for anything else. */
export function stripIPv6Brackets(hostname: string): string {
  return hostname.length >= 2 && hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isDisallowedIPv4(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  const a = parts[0] ?? NaN;
  const b = parts[1] ?? NaN;
  const c = parts[2] ?? NaN;
  const d = parts[3] ?? NaN;
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed -> fail closed
  if (a === 127) return true; // loopback (127/8)
  if (a === 10) return true; // private 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 169 && b === 254) return true; // link-local 169.254/16
  if (a === 0) return true; // unspecified / "this network" (0.0.0.0/8)
  if (a >= 224 && a <= 239) return true; // multicast 224/4
  if (a === 255 && b === 255 && c === 255 && d === 255) return true; // broadcast
  // M-6 fix wave: additional deny ranges.
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10 (incl. Alibaba Cloud metadata 100.100.100.200)
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 203.0.113.0/24
  if (a >= 240) return true; // reserved/"future use" 240.0.0.0/4 (also re-covers 255.255.255.255/broadcast)
  return false;
}

/**
 * Parses a syntactically-valid IPv6 literal (per `node:net`'s `isIPv6`,
 * always checked by the caller first) into its 16 raw bytes — M-5 fix
 * wave: classification below compares BYTE PREFIXES against these, never
 * strings, so an IPv4-mapped/NAT64/6to4 address classifies identically
 * regardless of which of its several equally-valid textual forms
 * (`::ffff:127.0.0.1` vs `::ffff:7f00:1`, the WHATWG `URL`-normalized hex
 * form of the exact same address) it arrives in. Returns `null` for
 * anything this parser cannot confidently interpret (malformed group
 * count, non-hex group, more than one `::`) — the caller fails closed on
 * `null`.
 */
function parseIPv6ToBytes(rawAddress: string): Uint8Array | null {
  const address = stripZoneId(rawAddress).toLowerCase();

  // A trailing embedded IPv4 dotted-quad (`::ffff:1.2.3.4`,
  // `64:ff9b::7f00:1` does NOT use this form — only the LAST 32 bits are
  // EVER written as dotted-quad, and only when the author chose to). The
  // two placeholder zero-groups keep group-counting correct; the real
  // bytes are patched in after the generic hextet parse below.
  let hextets = address;
  let embeddedIPv4: [number, number, number, number] | null = null;
  const ipv4TailMatch = /(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (ipv4TailMatch?.[1]) {
    const quad = ipv4TailMatch[1];
    const parts = quad.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    embeddedIPv4 = [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
    hextets = `${address.slice(0, address.length - quad.length)}0:0`;
  }

  const halves = hextets.split("::");
  if (halves.length > 2) return null; // more than one "::" is never valid

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups = segment.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  let groups: number[];
  if (halves.length === 2) {
    const left = parseGroups(halves[0]!);
    const right = parseGroups(halves[1]!);
    if (left === null || right === null) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    const single = parseGroups(hextets);
    if (single === null || single.length !== 8) return null;
    groups = single;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i]! >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  if (embeddedIPv4) {
    bytes[12] = embeddedIPv4[0];
    bytes[13] = embeddedIPv4[1];
    bytes[14] = embeddedIPv4[2];
    bytes[15] = embeddedIPv4[3];
  }
  return bytes;
}

function bytesStartWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

function embeddedIPv4String(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

const IPV4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff] as const;
const IPV4_COMPATIBLE_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as const;
/** NAT64 well-known prefix, RFC 6052. */
const NAT64_PREFIX = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0] as const;

function isDisallowedIPv6Bytes(bytes: Uint8Array): boolean {
  if (bytes.every((b, i) => (i === 15 ? b === 1 : b === 0))) return true; // ::1 loopback
  if (bytes.every((b) => b === 0)) return true; // :: unspecified
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // ULA fc00::/7
  if (bytes[0] === 0xff) return true; // multicast ff00::/8

  // IPv4-mapped (::ffff:0:0/96) — covers BOTH the dotted-quad textual form
  // and the hex-group form (parseIPv6ToBytes produces identical bytes for
  // either), closing the exact gap M-5 found.
  if (bytesStartWith(bytes, IPV4_MAPPED_PREFIX) && isDisallowedIPv4(embeddedIPv4String(bytes, 12))) return true;
  // Deprecated IPv4-compatible (::0.0.0.0/96, excluding ::/96 itself which
  // is already the unspecified-address check above).
  if (bytesStartWith(bytes, IPV4_COMPATIBLE_PREFIX) && !bytes.slice(12).every((b) => b === 0) && isDisallowedIPv4(embeddedIPv4String(bytes, 12)))
    return true;
  // NAT64 well-known prefix (64:ff9b::/96, RFC 6052).
  if (bytesStartWith(bytes, NAT64_PREFIX) && isDisallowedIPv4(embeddedIPv4String(bytes, 12))) return true;
  // 6to4 (2002::/16) — the next 32 bits (bytes 2-5) are the embedded IPv4.
  if (bytes[0] === 0x20 && bytes[1] === 0x02 && isDisallowedIPv4(embeddedIPv4String(bytes, 2))) return true;

  return false;
}

function isDisallowedIPv6(rawAddress: string): boolean {
  const bytes = parseIPv6ToBytes(rawAddress);
  if (!bytes) return true; // malformed -> fail closed
  return isDisallowedIPv6Bytes(bytes);
}

/** True iff `address` (an IP literal, NOT a hostname, NOT bracketed) falls
 *  in a loopback/private/link-local/ULA/multicast/broadcast/unspecified/
 *  CGNAT/benchmarking/TEST-NET/reserved range per LD5's list (M-5/M-6 fix
 *  wave additions noted inline above). An address of unrecognized shape
 *  fails closed (treated as disallowed) rather than silently passing
 *  through. */
export function isDisallowedAddress(address: string): boolean {
  if (isIPv4(address)) return isDisallowedIPv4(address);
  if (isIPv6(address)) return isDisallowedIPv6(address);
  return true;
}

// ============================================================================
// host validation
// ============================================================================

export interface HostResolution {
  /** Non-null exactly when this hostname has a SPECIFIC, ALREADY-VALIDATED
   *  address to dial directly (an IP literal, or a DNS name that was
   *  resolved+validated here) — `hardenedFetch` pins its actual socket
   *  connection to this address, never re-resolving (DNS-rebinding fix,
   *  this file's header). Null ONLY for the LAN-allowlist exact-hostname
   *  bypass, where (by existing, tested contract) this module never
   *  resolves the name at all — see this file's header for why that one
   *  path stays unpinned. */
  pinnedAddress: string | null;
  family: 4 | 6 | null;
}

/**
 * Resolves + validates a hostname (or IP literal) against LD5's allow/deny
 * rules EXACTLY ONCE, returning the specific address to dial (DNS-rebinding
 * fix, this file's header). Throws `HardenedFetchError` on any rejection.
 * `lanAllowlist` entries are matched by exact, case-insensitive string
 * equality against the ORIGINAL hostname/IP literal as written — no
 * CIDR/wildcard matching (migrations/0014_plugins.sql's lan_allowlist
 * column comment).
 */
/** Exported for direct testing of the DNS-rebinding-fix pinning DECISION
 *  (which address, if any, gets pinned for a given hostname/allowlist/DNS
 *  answer) independent of `hardenedFetch`'s own network transport — see
 *  ssrf.spec.ts's "resolveAndValidateHost (pinning decision)" suite. */
export async function resolveAndValidateHost(
  hostname: string,
  lanAllowlist: readonly string[],
  dnsLookup: DnsLookupFn,
): Promise<HostResolution> {
  const allowSet = new Set(lanAllowlist.map((h) => h.toLowerCase()));
  // M-5 fix wave: strip IPv6 brackets BEFORE the isIP check — `URL.hostname`
  // for `http://[::1]/` is the literal string `"[::1]"`, which `isIP`
  // does not recognize at all (see this file's header).
  const literal = stripIPv6Brackets(hostname);

  if (isIP(literal) !== 0) {
    // An IP literal has no DNS resolution step at all — the address IS
    // the literal, unambiguously, whether or not it happens to also
    // appear in the allowlist (which only ever affects whether the
    // disallowed-RANGE check is skipped, never what address gets dialed).
    if (!allowSet.has(hostname.toLowerCase()) && !allowSet.has(literal.toLowerCase()) && isDisallowedAddress(literal)) {
      throw new HardenedFetchError(
        "disallowed-address",
        hostname,
        `"${hostname}" is not a publicly routable address and is not in this plugin's lan_allowlist`,
      );
    }
    return { pinnedAddress: literal, family: isIPv4(literal) ? 4 : 6 };
  }

  if (allowSet.has(hostname.toLowerCase())) {
    // LAN-allowlist exact-hostname bypass — see this file's header for why
    // this one path is never resolved by this module and stays unpinned.
    return { pinnedAddress: null, family: null };
  }

  let addresses: DnsAddress[];
  try {
    addresses = await dnsLookup(hostname);
  } catch (err) {
    throw new HardenedFetchError(
      "dns-resolution-failed",
      hostname,
      `DNS resolution for "${hostname}" failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) {
    throw new HardenedFetchError("dns-resolution-failed", hostname, `DNS resolution for "${hostname}" returned no addresses`);
  }
  for (const { address } of addresses) {
    if (isDisallowedAddress(address)) {
      throw new HardenedFetchError(
        "disallowed-address",
        hostname,
        `"${hostname}" resolves to "${address}", a non-publicly-routable address, and is not in this plugin's lan_allowlist`,
      );
    }
  }
  // Pin to the FIRST validated address — every returned address was
  // checked above (a hostname resolving to even one disallowed address is
  // rejected wholesale, this file's header), so any of them would be
  // equally valid to dial; the first is as good as any, and is now the
  // ONLY one this module ever actually connects to for this call.
  const chosen = addresses[0]!;
  return { pinnedAddress: chosen.address, family: isIPv4(chosen.address) ? 4 : 6 };
}

/** Validates a hostname (or IP literal) against LD5's allow/deny rules.
 *  Throws HardenedFetchError on any rejection; resolves silently when the
 *  host is allowed. Thin wrapper over `resolveAndValidateHost` that
 *  discards the resolved address — kept as its own export because it is
 *  independently unit-tested and used as a pure allow/deny predicate by
 *  callers that do not need (or want) the pinning behavior. */
export async function assertHostAllowed(
  hostname: string,
  lanAllowlist: readonly string[],
  dnsLookup: DnsLookupFn = defaultDnsLookup,
): Promise<void> {
  await resolveAndValidateHost(hostname, lanAllowlist, dnsLookup);
}

// ============================================================================
// hardenedFetch
// ============================================================================

export interface HardenedFetchOptions {
  fetchImpl?: typeof fetch | undefined;
  timeoutMs: number;
  maxResponseBytes: number;
  lanAllowlist?: readonly string[] | undefined;
  dnsLookup?: DnsLookupFn | undefined;
}

export interface HardenedFetchResult {
  status: number;
  headers: Headers;
  bodyText: string;
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function headersInitToRecord(headers: RequestInit["headers"]): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [k, v] of headers) out[k] = v;
    return out;
  }
  return { ...(headers as Record<string, string>) };
}

/**
 * DNS-rebinding fix (this file's header): dials `pinnedAddress` DIRECTLY —
 * never re-resolving DNS, since Node's own connection layer never performs
 * a lookup at all when handed a literal IP — while presenting the
 * ORIGINAL hostname (`new URL(url).hostname`, including port if
 * non-default) as the `Host` header and, for HTTPS, as the TLS SNI
 * `servername`, so a virtual-hosted or certificate-name-checked plugin
 * server behaves identically to a normal (unpinned) request. Implements
 * only the slice of `fetch` this module's callers ever use — method,
 * headers, a string/Buffer/Uint8Array body in; status, headers, and a
 * streamed body out, wrapped as a real `Response` via
 * `Readable.toWeb` — zero new dependencies (`node:http`/`node:https` core
 * modules only, exactly as the adversarial review's remediation direction
 * specifies).
 */
function pinnedDialFetch(url: string, init: RequestInit, pinnedAddress: string, family: 4 | 6, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const impl = isHttps ? httpsRequest : httpRequest;
    const headers = headersInitToRecord(init.headers);
    const hostHeader = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    const isIpLiteralHost = isIP(stripIPv6Brackets(parsed.hostname)) !== 0;

    const req = impl(
      {
        method: init.method ?? "GET",
        host: pinnedAddress,
        hostname: pinnedAddress,
        family,
        port: parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
        path: `${parsed.pathname}${parsed.search}`,
        headers: { ...headers, host: hostHeader },
        // SNI only makes sense for a real DNS name — an IP-literal host
        // has no meaningful SNI value (and some TLS stacks reject an IP
        // literal there), so this is omitted for that case.
        ...(isHttps && !isIpLiteralHost ? { servername: parsed.hostname } : {}),
        signal,
      },
      (res: IncomingMessage) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const v of value) responseHeaders.append(key, v);
          } else {
            responseHeaders.set(key, value);
          }
        }
        resolve(
          new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            headers: responseHeaders,
          }),
        );
      },
    );

    req.on("error", (err) => reject(err));

    const body = init.body;
    if (body === undefined || body === null) {
      req.end();
    } else if (typeof body === "string") {
      req.end(body);
    } else if (body instanceof Uint8Array) {
      req.end(Buffer.from(body));
    } else {
      // Every current caller in this codebase sends a JSON.stringify'd
      // string body (call-plugin.ts's callers) — any other RequestInit.body
      // shape (a ReadableStream, Blob, FormData, ...) is out of scope for
      // this minimal fetch-alike. Fail loudly rather than silently drop it.
      req.destroy(new Error("pinnedDialFetch: unsupported request body type — only string/Uint8Array/undefined are supported"));
    }
  });
}

async function readCapped(response: Response, maxBytes: number, targetUrl: string, controller: AbortController): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          throw new HardenedFetchError("response-too-large", targetUrl, `response exceeded the ${maxBytes}-byte cap`);
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released by an abort — never let cleanup itself throw.
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export interface HardenedFetchRawOptions {
  fetchImpl?: typeof fetch | undefined;
  timeoutMs: number;
  lanAllowlist?: readonly string[] | undefined;
  dnsLookup?: DnsLookupFn | undefined;
}

/**
 * AUD-A7c-001: same SSRF validation + DNS-pinning + redirect rejection as
 * `hardenedFetch` below — same scheme check, same `resolveAndValidateHost`
 * call, same pinned-dial-or-fallback branch, same "a 3xx is a typed
 * rejection, never followed" rule — but hands back the raw, STILL-
 * STREAMING `Response` instead of buffering the body into a UTF-8-decoded
 * `bodyText`. `hardenedFetch`'s capped-string body is right for the small
 * JSON plugin-capability responses it exists for; it is WRONG for a binary
 * body — decoding arbitrary bytes as UTF-8 and handing back only the
 * decoded string is lossy (invalid byte sequences become U+FFFD) and would
 * silently corrupt anything that isn't valid UTF-8 text, e.g. a JPEG/PNG.
 * Callers that must stream a binary body straight to disk without ever
 * buffering the whole thing in memory (apps/worker/src/image/download.ts,
 * docs/PLAN.md §9.2 "streams everywhere") use this instead — this is a
 * second CONSUMPTION MODE of the one guard, not a second guard: the
 * validation/pinning logic below is called, never re-implemented.
 *
 * The timeout here deliberately covers the WHOLE request, not just
 * "headers arrived" — the same `AbortController`/timer stay wired to the
 * request/response for as long as the caller is still reading
 * `response.body`, so a target that responds promptly but then drips the
 * body slowly enough to stall a download is still bounded. If the body
 * finishes first, the still-pending timer fires harmlessly afterward (an
 * abort() on an already-completed request is a no-op) and is GC'd once it
 * does — there is no explicit dispose() to call.
 */
export async function hardenedFetchRaw(url: string, opts: HardenedFetchRawOptions): Promise<Response> {
  const parsed = safeParseUrl(url);
  if (!parsed) throw new HardenedFetchError("invalid-url", url, `"${url}" is not a parseable URL`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HardenedFetchError("unsupported-scheme", url, `scheme "${parsed.protocol}" is not http/https`);
  }

  const resolution = await resolveAndValidateHost(parsed.hostname, opts.lanAllowlist ?? [], opts.dnsLookup ?? defaultDnsLookup);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let response: Response;
  try {
    if (opts.fetchImpl) {
      // Test/caller-supplied transport override — same meaning as
      // hardenedFetch's identical branch below: the caller already fully
      // controls "the network" here, but validation above still ran.
      response = await opts.fetchImpl(url, { redirect: "manual", signal: controller.signal });
    } else if (resolution.pinnedAddress) {
      response = await pinnedDialFetch(url, {}, resolution.pinnedAddress, resolution.family!, controller.signal);
    } else {
      // LAN-allowlist exact-hostname bypass — see resolveAndValidateHost's
      // doc comment.
      response = await fetch(url, { redirect: "manual", signal: controller.signal });
    }
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new HardenedFetchError("timeout", url, `request timed out after ${opts.timeoutMs}ms`);
    }
    throw new HardenedFetchError("network-error", url, err instanceof Error ? err.message : String(err));
  }

  if (response.status >= 300 && response.status < 400) {
    clearTimeout(timer);
    throw new HardenedFetchError(
      "redirect-not-followed",
      url,
      `received a ${response.status} redirect, which hardenedFetch never follows`,
    );
  }

  // R6 fix wave: the timer stays running past this point on purpose (see
  // this doc comment above) so it can still abort a body the caller reads
  // slowly AFTER this function returns — but a running timer is also, by
  // itself, a reason Node keeps the event loop (and so the whole worker
  // process) alive. `unref()` removes ONLY that side effect: the timer
  // still fires and still calls `controller.abort()` on schedule, so the
  // whole-request bound above is unchanged; it just no longer counts as a
  // reason to stay alive for a process that would otherwise be done. Without
  // this, every successful image download left a pending timer that could
  // delay worker shutdown by up to `timeoutMs`.
  timer.unref();
  return response;
}

/**
 * The sole network-issuing primitive in this package (see this file's
 * header). Validates scheme + resolved address(es) BEFORE issuing any
 * request, never follows a redirect, enforces a hard timeout, and caps the
 * response body while streaming it. Throws `HardenedFetchError` for every
 * rejection reason (never a bare Error, never a silent partial result) so
 * callers can branch on `.reason`.
 */
export async function hardenedFetch(url: string, init: RequestInit, opts: HardenedFetchOptions): Promise<HardenedFetchResult> {
  const parsed = safeParseUrl(url);
  if (!parsed) throw new HardenedFetchError("invalid-url", url, `"${url}" is not a parseable URL`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HardenedFetchError("unsupported-scheme", url, `scheme "${parsed.protocol}" is not http/https`);
  }

  const resolution = await resolveAndValidateHost(parsed.hostname, opts.lanAllowlist ?? [], opts.dnsLookup ?? defaultDnsLookup);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let response: Response;
    try {
      if (opts.fetchImpl) {
        // Test/caller-supplied transport override — no pinning (the caller
        // already fully controls "the network" here; see this function's
        // own tests, which exercise this seam extensively without any real
        // DNS/socket involved at all).
        response = await opts.fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal });
      } else if (resolution.pinnedAddress) {
        // DNS-rebinding fix (this file's header): dial the EXACT address
        // resolveAndValidateHost already validated, never re-resolving.
        response = await pinnedDialFetch(url, init, resolution.pinnedAddress, resolution.family!, controller.signal);
      } else {
        // LAN-allowlist exact-hostname bypass — this file's header's
        // documented residual: no validated address to pin to, dial
        // normally (the platform's own DNS resolution).
        response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
      }
    } catch (err) {
      if (controller.signal.aborted) {
        throw new HardenedFetchError("timeout", url, `request timed out after ${opts.timeoutMs}ms`);
      }
      throw new HardenedFetchError("network-error", url, err instanceof Error ? err.message : String(err));
    }

    if (response.status >= 300 && response.status < 400) {
      throw new HardenedFetchError(
        "redirect-not-followed",
        url,
        `received a ${response.status} redirect, which hardenedFetch never follows`,
      );
    }

    // H-3 fix wave: before this fix, ONLY an abort during the `fetchImpl`
    // call above (headers not yet received) was classified into a typed
    // HardenedFetchError. A plugin that returns headers promptly and then
    // drips the body slowly enough to trip the SAME AbortController's
    // timeout fires the abort INSIDE `readCapped`'s `reader.read()` call
    // instead — `response-too-large` is already typed (readCapped throws it
    // itself), but a genuine timeout/abort there previously propagated as
    // a raw, untyped `DOMException: AbortError`, which callPlugin's
    // `instanceof HardenedFetchError` catch does not recognize — so it
    // rethrew, skipping breaker/backoff accounting entirely (see
    // call-plugin.ts's own H-3 hardening for the second layer of this fix).
    let bodyText: string;
    try {
      bodyText = await readCapped(response, opts.maxResponseBytes, url, controller);
    } catch (err) {
      if (err instanceof HardenedFetchError) throw err; // already typed (response-too-large)
      if (controller.signal.aborted) {
        throw new HardenedFetchError("timeout", url, `request timed out after ${opts.timeoutMs}ms while reading the response body`);
      }
      throw new HardenedFetchError("network-error", url, err instanceof Error ? err.message : String(err));
    }
    return { status: response.status, headers: response.headers, bodyText };
  } finally {
    clearTimeout(timer);
  }
}
