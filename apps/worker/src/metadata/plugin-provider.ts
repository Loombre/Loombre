// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/plugin-provider.ts
//
// LPP v1 (Lane W3), mission point 1: wraps a registered plugin row (with a
// GRANTED metadata-provider capability) as an apps/worker/src/metadata/
// provider.ts `MetadataProvider` — the LPP host ADAPTER. Calls go through
// @loombre/plugin-host's `callPlugin` (timeout + circuit breaker + SSRF
// guard with the plugin's own `lan_allowlist`) to the plugin's manifest-
// declared endpoints; every request/response body is validated against the
// FROZEN @loombre/plugin-protocol wire schemas (search/details/images) —
// a schema-invalid response is a typed `LppProviderCallError`, exactly the
// same "provider failed for this item, try the next in chain" outcome
// apps/worker/src/metadata/consumer.ts's resolveViaProviderChain already
// gives a thrown built-in-provider error (its `catch` logs and continues)
// — never an uncaught crash, never a stall (C6).
//
// `name` is the STABLE identifier `lpp:<pluginId>` (lppProviderName below)
// — never the plugin's own manifest `name` field, which can change on any
// re-fetch/re-approval and is not a safe provenance/DB-persisted string
// (provider_ids.provider, metadata_provenance.source's "provider:<name>"
// tag — see consumer.ts).
//
// H-2 FIX WAVE CORRECTION: this file used to set the returned provider's
// `contentClass` to `plugin.contentClass` — the plugin's own AGGREGATE
// `plugins.content_class` column — per an earlier reading of C5 as
// "capability-uniform: ONE content-class value governs a plugin across
// every capability it holds". The adversarial review (H-2) found that
// reading itself in tension with C5's OWN text ("general-scoped plugins
// never receive restricted data through ANY capability" — the CAPABILITY,
// not the plugin row, is general-scoped in a perfectly ordinary mixed
// manifest: a restricted-scoped metadata-provider alongside a
// general-scoped event-subscriber). A sibling capability's scope must never
// WIDEN this one's. `createLppMetadataProvider` below now gates
// construction on the metadata-provider CAPABILITY's own declared
// `contentClass` field (parsed straight off the manifest), not the
// aggregate column, and the returned provider's `contentClass` is that same
// per-capability value — by construction, once layer 3 has passed, the
// capability's own class already EQUALS `deps.targetContentClass`, so this
// is never observably different from the aggregate in the common
// (non-mixed) case; it only differs, correctly, in the mixed case the
// aggregate used to mishandle. `plugins.content_class` (the aggregate) is
// still read into `LppProviderPluginInput.contentClass` and still governs
// chain ELIGIBILITY at layers 1/2 (library-provider-chains.ts write time,
// chain-resolution.ts pre-filter) — this layer-3 construction-time check
// is the one "genuinely immediately before any call" gate (see below), so
// it is where the per-capability correction has to live for the security
// property to hold; a layer-1/2 false-positive admission is caught here
// and simply produces no provider (a functional no-op for a
// misconfigured/mixed chain entry), never a leak.
//
// C5 STRICT defense-in-depth, LAYER 3 ("a hard runtime check in the
// adapter ... immediately before any plugin provider call, even under
// misconfiguration" — the mission's own wording): `createLppMetadataProvider`
// is called FRESH, with a freshly-DB-read plugin row, once per metadata
// job (apps/worker/src/metadata/chain-resolution.ts never caches a
// constructed adapter across jobs) — construction itself is the "hard
// runtime check", refusing to produce a provider object at all
// (`return null`) unless `plugin.contentClass` EQUALS
// `deps.targetContentClass` (this job's item/library content class)
// EXACTLY, duplicating apps/server/src/plugins/scope.ts's
// assertPluginAttachAllowed rule (packages/db/apps/worker cannot import
// apps/server — the dependency graph runs the other way, same
// "documented duplication" precedent as mirrorServerDataDir). Because a
// fresh construction (or refusal) happens before ANY of this job's calls
// could reach the adapter's search/fetchDetails/fetchImages methods, this
// is genuinely "immediately before any plugin provider call" — there is
// no long-lived cached adapter instance that could go stale relative to a
// later content-class mismatch. Layer 1 (chain write time) is
// packages/db/src/query/library-provider-chains.ts's
// replaceLibraryProviderChain; layer 2 (chain-resolution time) is
// chain-resolution.ts's own pre-filter, which is REDUNDANT with this
// layer by design (defense in depth, not "pick one").
//
// Breaker (C6, LD8): `deps.breaker` is a `PluginCircuitBreaker` the CALLER
// owns and holds per plugin, in-memory, for the lifetime of the worker
// process (the documented W2 cross-process tradeoff — see
// packages/plugin-host/src/breaker.ts's header). `callLppEndpoint` below
// detects the exact call whose failure trips the breaker open (a
// closed/half-open -> open transition) and — ONLY at that trip moment,
// per the mission's literal pairing — calls `setPluginEnabledAndEmit`
// (disabled, reason 'breaker') and `setPluginHealthAndEmit` through
// `@loombre/db`, so a dead plugin auto-disables itself durably rather than
// being retried by every future job forever. Lane decision (documented,
// not re-derived from any rail): ORDINARY non-tripping failures update
// only the in-process breaker's own counters, never `plugins.
// consecutive_failures` — the mission's own instruction to W3 names only
// the trip-time pair of DB writes, and per-call DB chatter on every
// ordinary failure would conflict with apps/server/src/plugins/
// plugin-health.service.ts's (W2, unmodified) ownership of that column's
// general health-check bookkeeping.

import {
  buildPluginRequestHeaders,
  callPlugin,
  BREAKER_COUNTED_REASONS,
  LPP_CAPABILITY_MAX_RESPONSE_BYTES,
  LPP_DETAILS_TIMEOUT_MS,
  LPP_IMAGES_TIMEOUT_MS,
  LPP_SEARCH_TIMEOUT_MS,
  type PluginCircuitBreaker,
} from '@loombre/plugin-host';
import {
  LppConfigSchema,
  LppDetailsResponseSchema,
  LppImagesResponseSchema,
  LppMetadataProviderCapabilitySchema,
  LppSearchResponseSchema,
  listTopLevelSecretFieldNames,
  type LppMetadataProviderCapability,
  type LppProviderDetails,
} from '@loombre/plugin-protocol';
import { setPluginEnabledAndEmit, setPluginHealthAndEmit } from '@loombre/db';
import type { DbOrTx } from '@loombre/db/internal';
import { resolvePluginConfigSecrets } from './plugin-keyring.js';
import type {
  ContentClass,
  MetadataProvider,
  PersonCredit,
  ProviderDetails,
  ProviderImageRef,
  ProviderRef,
  ProviderSearchResult,
  SearchQuery,
} from './provider.js';

/** The STABLE provider name persisted in provider_ids.provider /
 *  metadata_provenance.source ("provider:<name>") for any item this
 *  adapter ever writes — `lpp:<pluginId>`, never the plugin's own
 *  manifest `name` (which can change on re-fetch). */
export function lppProviderName(pluginId: string): string {
  return `lpp:${pluginId}`;
}

export class LppProviderCallError extends Error {
  readonly pluginId: string;
  readonly endpoint: 'search' | 'details' | 'images';

  constructor(pluginId: string, endpoint: 'search' | 'details' | 'images', reason: string) {
    super(`lpp plugin "${pluginId}" ${endpoint} call failed: ${reason}`);
    this.name = 'LppProviderCallError';
    this.pluginId = pluginId;
    this.endpoint = endpoint;
  }
}

/** The subset of a `plugins` row this factory needs — a narrow local
 *  interface rather than importing @loombre/db's `PluginRow` directly, so
 *  this module stays decoupled from the exact Kysely `Selectable` shape
 *  (callers pass a `PluginRow` in; structural typing accepts it). */
export interface LppProviderPluginInput {
  id: string;
  baseUrl: string;
  enabled: boolean;
  /** plugins.content_class — the plugin's AGGREGATE scope (see file
   *  header for why this, not the capability entry's own contentClass, is
   *  used both as the returned provider's `contentClass` and as the C5
   *  input). */
  contentClass: ContentClass;
  lanAllowlist: readonly string[];
  grantedCapabilityTypes: readonly string[];
  /** Verbatim GET /lpp/manifest snapshot (plugins.manifest). */
  manifest: Record<string, unknown>;
  /** Non-secret configSchema field values (plugins.config). */
  config: Record<string, unknown>;
}

export interface CreateLppMetadataProviderDeps {
  db: DbOrTx;
  breaker: PluginCircuitBreaker;
  /** C5 STRICT layer-3 check input — the content class this ONE
   *  construction call is being asked to serve (this job's item/library
   *  content class). See file header. */
  targetContentClass: ContentClass;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

function extractMetadataProviderCapability(manifest: Record<string, unknown>): LppMetadataProviderCapability | null {
  const raw = (manifest as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(raw)) return null;
  const entry = raw.find((c) => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'metadata-provider');
  if (!entry) return null;
  const parsed = LppMetadataProviderCapabilitySchema.safeParse(entry);
  return parsed.success ? parsed.data : null;
}

function extractSecretFieldNames(manifest: Record<string, unknown>): string[] {
  const parsed = LppConfigSchema.safeParse((manifest as { configSchema?: unknown }).configSchema);
  if (!parsed.success) return [];
  return listTopLevelSecretFieldNames(parsed.data);
}

/** Structurally typed against zod's own SafeParseError shape (no direct
 *  `zod` import needed here — @loombre/plugin-protocol already depends on
 *  it and re-exports every schema this file uses) — mirrors
 *  apps/server/src/settings/settings.service.ts's own
 *  `issues.map(...).join('; ')` convention for turning a failed parse
 *  into one human-readable line. `path` is zod's own `PropertyKey[]`
 *  (string | number | symbol) — mapped through `String()` since a path
 *  segment is, in practice, always a string (object key) or number (array
 *  index), never a symbol, but `Array.prototype.join` would throw on a
 *  literal symbol element. */
function describeSchemaError(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');
}

interface AdapterRuntime {
  pluginId: string;
  baseUrl: string;
  lanAllowlist: readonly string[];
  breaker: PluginCircuitBreaker;
  db: DbOrTx;
  fetchImpl: (typeof fetch) | undefined;
  clock: () => number;
  log: (message: string) => void;
  secretFieldNames: readonly string[];
  config: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
}

const TIMEOUT_MS_FOR: Record<'search' | 'details' | 'images', number> = {
  search: LPP_SEARCH_TIMEOUT_MS,
  details: LPP_DETAILS_TIMEOUT_MS,
  images: LPP_IMAGES_TIMEOUT_MS,
};

/** Fires ONLY on the exact call whose breaker-counted failure trips the
 *  breaker closed/half-open -> open — see file header for why a
 *  before/after `snapshot().state` diff is equivalent to
 *  `PluginBreakerFailureOutcome.tripped` here (callPlugin owns the
 *  admission/outcome bookkeeping itself via `opts.breaker`, so this
 *  function never calls `breaker.onFailure`/`onSuccess` directly — it only
 *  OBSERVES the transition callPlugin already made). Best-effort: a DB
 *  write failure here is logged and swallowed, never rethrown — the
 *  ORIGINAL provider-call error is what the caller ultimately throws. */
async function maybeDisableOnBreakerTrip(runtime: AdapterRuntime, beforeState: string, nowMs: number): Promise<void> {
  const after = runtime.breaker.snapshot();
  const justTripped = beforeState !== 'open' && after.state === 'open';
  if (!justTripped) return;

  try {
    await setPluginEnabledAndEmit(runtime.db, {
      pluginId: runtime.pluginId,
      enabled: false,
      reason: 'breaker',
      actorUserId: null,
      nowMs,
    });
    await setPluginHealthAndEmit(runtime.db, {
      pluginId: runtime.pluginId,
      healthState: 'unhealthy',
      consecutiveFailures: after.consecutiveFailures,
      ok: false,
      checkedAtMs: nowMs,
    });
  } catch (err) {
    runtime.log(
      `lpp-provider: plugin "${runtime.pluginId}" tripped its circuit breaker but the DB disable/health write failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** The one call-site every search/fetchDetails/fetchImages method routes
 *  through: resolves secrets, builds headers, calls callPlugin (timeout +
 *  breaker + SSRF), classifies the outcome, and returns the parsed JSON
 *  body — or throws a typed LppProviderCallError for every failure mode
 *  (transport, non-2xx, invalid JSON). Callers still owe their OWN
 *  wire-schema validation of the parsed body (this function only proves
 *  "valid JSON came back over a successful HTTP call", not "shaped
 *  correctly"). */
async function callLppEndpoint(
  runtime: AdapterRuntime,
  endpointKind: 'search' | 'details' | 'images',
  path: string,
  body: unknown
): Promise<unknown> {
  const resolvedUrl = new URL(path, runtime.baseUrl);
  const baseOrigin = new URL(runtime.baseUrl).origin;
  // H-5 fix wave, defense in depth: the frozen path regex
  // (packages/plugin-protocol) now rejects protocol-relative (`//`, `/\`)
  // paths at manifest-parse time, which is what actually prevents this from
  // being reachable — this assertion is the second, independent layer LD5's
  // "ANY 3xx is a typed failure" spirit calls for: even a stored manifest
  // snapshot that predates the narrowing (or a future bug in the parser)
  // can never make this adapter dial a host other than the one the admin
  // approved.
  if (resolvedUrl.origin !== baseOrigin) {
    throw new LppProviderCallError(
      runtime.pluginId,
      endpointKind,
      `endpoint path "${path}" resolves to origin "${resolvedUrl.origin}", which does not match the plugin's registered baseUrl origin "${baseOrigin}" — refusing to call`
    );
  }
  const url = resolvedUrl.toString();
  const secrets = await resolvePluginConfigSecrets(runtime.pluginId, runtime.secretFieldNames, runtime.env);
  const headers = buildPluginRequestHeaders(runtime.config, secrets);

  const nowMs = runtime.clock();
  const beforeState = runtime.breaker.snapshot().state;

  let result: Awaited<ReturnType<typeof callPlugin>>;
  try {
    result = await callPlugin(
      url,
      { method: 'POST', headers, body: JSON.stringify(body) },
      {
        // exactOptionalPropertyTypes: omit the key entirely rather than set
        // it to `undefined` — CallPluginOptions.fetchImpl?: typeof fetch has
        // no explicit `| undefined` in its own type.
        ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}),
        clock: runtime.clock,
        timeoutMs: TIMEOUT_MS_FOR[endpointKind],
        maxResponseBytes: LPP_CAPABILITY_MAX_RESPONSE_BYTES,
        lanAllowlist: runtime.lanAllowlist,
        breaker: runtime.breaker,
      }
    );
  } catch (err) {
    // H-3 fix wave, defense in depth: callPlugin's own contract is "never
    // throws for an ordinary failure mode" (packages/plugin-host's
    // call-plugin.ts, itself hardened this same fix wave) — this catch
    // exists purely so a host bug there can never let a throw unwind past
    // this adapter's failure classification/breaker recording, which is
    // exactly the failure mode H-3 found (a mid-body timeout escaping as an
    // untyped DOMException meant the breaker/backoff never fired at all).
    runtime.breaker.onFailure(nowMs);
    await maybeDisableOnBreakerTrip(runtime, beforeState, nowMs);
    const detail = err instanceof Error ? err.message : String(err);
    throw new LppProviderCallError(runtime.pluginId, endpointKind, `network-error: ${detail}`);
  }

  if (!result.ok) {
    if (result.reason !== 'circuit-open' && BREAKER_COUNTED_REASONS.includes(result.reason)) {
      await maybeDisableOnBreakerTrip(runtime, beforeState, nowMs);
    }
    const detail = result.reason === 'circuit-open' ? 'circuit breaker is open' : `${result.reason}: ${result.detail}`;
    throw new LppProviderCallError(runtime.pluginId, endpointKind, detail);
  }

  if (result.status < 200 || result.status >= 300) {
    throw new LppProviderCallError(runtime.pluginId, endpointKind, `http ${result.status}: ${result.bodyText.slice(0, 500)}`);
  }

  try {
    return JSON.parse(result.bodyText);
  } catch (err) {
    throw new LppProviderCallError(runtime.pluginId, endpointKind, `invalid JSON response: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function encodeRef(ref: ProviderRef): ProviderRef {
  return {
    provider: ref.provider,
    externalId: ref.externalId,
    mediaKind: ref.mediaKind,
    seasonNumber: ref.seasonNumber ?? null,
    episodeNumber: ref.episodeNumber ?? null,
    ...(ref.entityKind !== undefined ? { entityKind: ref.entityKind } : {}),
  };
}

/** The wire schema's `ProviderRef` shape is field-for-field identical to
 *  the internal one EXCEPT that zod's `.optional()` fields carry an
 *  explicit `| undefined` in their inferred TS type (this repo's
 *  `exactOptionalPropertyTypes: true` distinguishes "key omitted" from
 *  "key present with value undefined" even though zod's own runtime
 *  behavior always omits an absent optional key) — this function
 *  re-normalizes a parsed wire ref into the internal `ProviderRef` type so
 *  that distinction disappears again, never omitting/mutating any value. */
function decodeRef(ref: {
  provider: string;
  externalId: string;
  mediaKind: ProviderRef['mediaKind'];
  seasonNumber?: number | null | undefined;
  episodeNumber?: number | null | undefined;
  entityKind?: 'artist' | 'album' | 'track' | undefined;
}): ProviderRef {
  return {
    provider: ref.provider,
    externalId: ref.externalId,
    mediaKind: ref.mediaKind,
    seasonNumber: ref.seasonNumber ?? null,
    episodeNumber: ref.episodeNumber ?? null,
    ...(ref.entityKind !== undefined ? { entityKind: ref.entityKind } : {}),
  };
}

/** Same exactOptionalPropertyTypes re-normalization as decodeRef, for
 *  LppPersonCredit -> PersonCredit's `credit?: string | null` field. */
function toInternalPersonCredit(p: { name: string; role: PersonCredit['role']; order: number; credit?: string | null | undefined }): PersonCredit {
  return { name: p.name, role: p.role, order: p.order, credit: p.credit ?? null };
}

function toInternalDetails(d: LppProviderDetails): ProviderDetails {
  const common = {
    title: d.title,
    sortTitle: d.sortTitle,
    year: d.year,
    overview: d.overview,
    communityRating: d.communityRating,
    contentRating: d.contentRating,
    genres: d.genres,
    tags: d.tags,
    people: d.people.map(toInternalPersonCredit),
    providerIds: d.providerIds,
  };
  switch (d.itemType) {
    case 'movie':
      return { ...common, itemType: 'movie', tagline: d.tagline, runtimeMs: d.runtimeMs };
    case 'series':
      return { ...common, itemType: 'series', status: d.status, airDateMs: d.airDateMs };
    case 'season':
      return { ...common, itemType: 'season', seasonNumber: d.seasonNumber };
    case 'episode':
      return { ...common, itemType: 'episode', seasonNumber: d.seasonNumber, episodeNumber: d.episodeNumber, airDateMs: d.airDateMs };
    case 'artist':
      return { ...common, itemType: 'artist' };
    case 'album':
      return { ...common, itemType: 'album' };
    case 'track':
      return { ...common, itemType: 'track', trackNumber: d.trackNumber, discNumber: d.discNumber, durationMs: d.durationMs };
  }
}

/**
 * Constructs (or refuses to construct — see file header, layer 3) an LPP
 * metadata-provider adapter for one plugin row. Returns `null` when the
 * plugin is not eligible at all (no granted metadata-provider capability,
 * a malformed/missing capability manifest entry, or a C5 STRICT
 * content-class mismatch) — distinct from the built-in providers'
 * `enabled: false` pattern (tmdb.ts et al.), which is reserved for "this
 * plugin IS a valid, in-scope metadata-provider but is administratively
 * disabled right now" (`plugin.enabled === false`, mission point 1:
 * "enabled follows plugins.enabled") — that case DOES construct normally,
 * relying on apps/worker/src/metadata/consumer.ts's existing
 * `!provider.enabled` skip.
 */
export function createLppMetadataProvider(plugin: LppProviderPluginInput, deps: CreateLppMetadataProviderDeps): MetadataProvider | null {
  const log = deps.log ?? ((message: string) => console.warn(message));

  if (!plugin.grantedCapabilityTypes.includes('metadata-provider')) {
    log(`lpp-provider: plugin "${plugin.id}" has no GRANTED metadata-provider capability`);
    return null;
  }

  const capability = extractMetadataProviderCapability(plugin.manifest);
  if (!capability) {
    log(`lpp-provider: plugin "${plugin.id}" manifest does not declare a valid metadata-provider capability entry`);
    return null;
  }

  // H-2 fix wave: gate on the metadata-provider CAPABILITY's own declared
  // contentClass — never the plugin's aggregate plugins.content_class
  // column — so a sibling capability (e.g. a restricted event-subscriber)
  // can never widen THIS capability's effective scope. See file header.
  if (capability.contentClass !== deps.targetContentClass) {
    log(
      `lpp-provider: refusing to construct a provider for plugin "${plugin.id}" — metadata-provider capability content_class="${capability.contentClass}" ` +
        `!== target content_class="${deps.targetContentClass}" (C5 STRICT, layer 3, per-capability)`
    );
    return null;
  }

  const runtime: AdapterRuntime = {
    pluginId: plugin.id,
    baseUrl: plugin.baseUrl,
    lanAllowlist: plugin.lanAllowlist,
    breaker: deps.breaker,
    db: deps.db,
    fetchImpl: deps.fetchImpl,
    clock: deps.clock ?? (() => Date.now()),
    log,
    secretFieldNames: extractSecretFieldNames(plugin.manifest),
    config: plugin.config,
    env: deps.env ?? process.env,
  };

  return {
    name: lppProviderName(plugin.id),
    // H-2 fix wave: the CAPABILITY's own contentClass, not the plugin's
    // aggregate column — see file header. Construction above already
    // proved these two are equal to deps.targetContentClass at this point,
    // so this is a behavior change only in the mixed-class case the
    // aggregate used to mishandle.
    contentClass: capability.contentClass,
    kinds: capability.mediaKinds,
    enabled: plugin.enabled,
    ...(plugin.enabled ? {} : { disabledReason: 'plugin is disabled' }),

    async search(query: SearchQuery): Promise<ProviderSearchResult[]> {
      const body = {
        mediaKind: query.mediaKind,
        title: query.title,
        year: query.year ?? null,
        ...(query.entityKind !== undefined ? { entityKind: query.entityKind } : {}),
      };
      const raw = await callLppEndpoint(runtime, 'search', capability.endpoints.search, body);
      const parsed = LppSearchResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new LppProviderCallError(plugin.id, 'search', `response failed schema validation: ${describeSchemaError(parsed.error)}`);
      }
      return parsed.data.results.map((r) => ({
        ref: decodeRef(r.ref),
        title: r.title,
        year: r.year ?? null,
        overview: r.overview ?? null,
        popularity: r.popularity ?? null,
      }));
    },

    async fetchDetails(ref: ProviderRef): Promise<ProviderDetails> {
      const raw = await callLppEndpoint(runtime, 'details', capability.endpoints.details, { ref: encodeRef(ref) });
      const parsed = LppDetailsResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new LppProviderCallError(plugin.id, 'details', `response failed schema validation: ${describeSchemaError(parsed.error)}`);
      }
      return toInternalDetails(parsed.data.details);
    },

    async fetchImages(ref: ProviderRef): Promise<ProviderImageRef[]> {
      const raw = await callLppEndpoint(runtime, 'images', capability.endpoints.images, { ref: encodeRef(ref) });
      const parsed = LppImagesResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new LppProviderCallError(plugin.id, 'images', `response failed schema validation: ${describeSchemaError(parsed.error)}`);
      }
      return parsed.data.images.map((img) => ({
        kind: img.kind,
        url: img.url,
        width: img.width ?? null,
        height: img.height ?? null,
      }));
    },
  };
}
