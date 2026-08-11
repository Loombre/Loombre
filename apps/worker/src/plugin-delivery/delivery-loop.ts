// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/plugin-delivery/delivery-loop.ts
//
// LPP v1 mission §3.2 — the event-subscriber outbox-fanout delivery loop.
// Per enabled subscriber plugin, in-order at-least-once delivery:
//
//   read events AFTER cursor_event_seq (batch cap LPP_DELIVERY_BATCH_MAX —
//     opus-review LD wave Finding 1 / migrations/
//     0040_plugin_delivery_cursor_seq.sql switched this from
//     cursor_event_id, which is unsafe as a PERSISTED same-millisecond
//     keyset tie-break; cursor_event_id is kept alongside for gap
//     detection + observability, see that migration's header)
//     -> filter to GRANTED types (plugin_event_grants intersection —
//        done by the read query itself, listCandidateEventsForDelivery)
//     -> clearance-gate (general-scoped subscribers only — C5, via the
//        EXISTING guard-compiled filterEventsForViewer, never a
//        reimplemented visibility rule; restricted-scoped subscribers
//        receive their granted types unfiltered, per
//        apps/server/src/plugins/scope.ts's pluginMayReceiveRestricted
//        doc comment naming THIS exact gate as its intended W4
//        integration point)
//     -> skip-if-empty
//     -> build frozen-schema batch (@loombre/plugin-protocol's
//        LppEventBatchSchema — validated defensively before sending)
//     -> pseudonymize (actor-field-map.ts, default ON)
//     -> sign with the plugin's HMAC secret (keyring.ts)
//     -> POST via @loombre/plugin-host's callPlugin (timeout + breaker +
//        SSRF guard with the plugin's own lan_allowlist) to the
//        manifest-declared delivery.endpoint
//     -> 2xx => advance cursor + stats; non-2xx/transport failure =>
//        this lane's own backoff (plugin_delivery_cursors.
//        consecutive_failures); a transport failure that TRIPS the
//        shared @loombre/plugin-host breaker => setPluginEnabledAndEmit
//        (disabled, 'breaker') + setPluginHealthAndEmit('unhealthy')
//        through @loombre/db — mirroring apps/worker/src/metadata/
//        plugin-provider.ts's maybeDisableOnBreakerTrip EXACTLY (LD8: one
//        shared, durable, cross-capability breaker signal; ORDINARY
//        non-tripping failures never touch plugins.consecutive_failures
//        or health_state, only the in-process breaker's own counters and
//        this lane's own plugin_delivery_cursors row) — a down plugin
//        stalls NOTHING else, because every plugin's tick runs
//        independently (Promise.allSettled in runOnce() below) and each
//        plugin's cursor/breaker/backoff state is entirely its own
//        row/object.
//
// GAP SEMANTICS (LPP v1 mission §3.2 "retention window ... gaps reported
// never skipped") — the precise rule this lane chose, since the mission
// text describes the requirement without pinning an exact algorithm:
//
//   A "gap" exists for a plugin exactly when there is at least one event
//   of a type it is granted, after its cursor, whose ts_ms is OLDER than
//   (now - LPP_DELIVERY_RETENTION_WINDOW_MS) — i.e. an event this plugin
//   WOULD have received that this loop is now skipping past. This is a
//   query (findOldestUnconsumedBeforeMs), not a time-since-last-attempt
//   heuristic: a plugin that has simply had nothing new to deliver for
//   8 days has NO gap (nothing was skipped), while a plugin whose cursor
//   is 8 days stale AND has real matching events in that span DOES.
//   Deliberately NOT clearance-aware for general-scoped subscribers (an
//   UNPINNED simplification — see this lane's final report): a gap is
//   detected against the granted-TYPE candidate set only, before the C5
//   filter runs, which can only ever OVER-report a gap (report one that
//   turns out to be entirely restricted-content events that subscriber
//   was never going to see anyway), never under-report one, and the
//   report itself carries no item/library detail — just a timestamp
//   range — so this cannot leak restricted-content existence.
//
//   Reporting is carried on the next batch that actually ships (the
//   frozen LppEventBatchSchema requires events.length >= 1, so a
//   gap-only empty batch is not a valid batch at all) — nothing is
//   persisted (no cursor jump, no gap_reported_through_ms write) until a
//   real batch with >=1 deliverable event successfully ships carrying
//   the gapReport, so "gaps are reported, never silent" holds even across
//   several empty/all-filtered ticks in a row: the gap is simply
//   recomputed fresh (against the current `now`) every tick until there
//   is something to attach it to, and the reported range only ever grows
//   MORE accurate (closer to the moment it's actually told), never lost.

import {
  advanceCursorPastFilteredEvents,
  ensurePseudonymSalt,
  filterEventsForViewer,
  findOldestUnconsumedBeforeMs,
  getDeliveryCursor,
  getPluginById,
  listCandidateEventsForDelivery,
  listEventSubscriberPlugins,
  recordDeliveryFailure,
  recordDeliverySuccess,
  setPluginEnabledAndEmit,
  setPluginHealthAndEmit,
  type EventSubscriberPlugin,
} from "@loombre/db";
import { BREAKER_COUNTED_REASONS, buildPluginRequestHeaders, PluginCircuitBreaker, callPlugin } from "@loombre/plugin-host";
import { LppConfigSchema, LppEventBatchSchema, listTopLevelSecretFieldNames, signLppBatch, type LppEventBatch, type LppGapReport } from "@loombre/plugin-protocol";
import { uuidv7 } from "@loombre/shared";
import { isRetryDue } from "./backoff.js";
import { pseudonymizePayload } from "./actor-field-map.js";
import { buildGeneralSubscriberViewerContext, pluginMayReceiveRestricted, type DeliveryDb } from "./clearance.js";
import {
  LPP_CAPABILITY_MAX_RESPONSE_BYTES,
  LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES,
  LPP_DELIVERY_BATCH_MAX,
  LPP_DELIVERY_POLL_INTERVAL_MS,
  LPP_DELIVERY_RETENTION_WINDOW_MS,
  LPP_DELIVERY_TIMEOUT_MS,
} from "./constants.js";
import { resolvePluginHmacSecret } from "./keyring.js";
import { extractEventSubscriberCapability, resolveDeliveryUrl, PluginEndpointOriginMismatchError } from "./manifest.js";
// M-1 fix wave: the SAME worker-side, read-only keyring resolver
// plugin-provider.ts's metadata-provider adapter already uses — reused
// directly (not duplicated) since it is protocol/capability-agnostic (a
// plugin's config secrets are stored per-plugin, not per-capability) and
// both modules live in apps/worker, no cross-app boundary to respect.
import { resolvePluginConfigSecrets } from "../metadata/plugin-keyring.js";
import { EPOCH_ZERO_BOUNDARY_UUID } from "./uuidv7.js";

export type DeliveryTickOutcome =
  | { kind: "invalid-manifest" }
  | { kind: "backoff-wait" }
  | { kind: "skip-empty" }
  | { kind: "advanced-no-content"; rawCount: number }
  | { kind: "no-secret" }
  | { kind: "delivered"; count: number; gapReported: boolean }
  | { kind: "breaker-tripped" }
  | { kind: "circuit-open" }
  | { kind: "invalid-batch-internal-error" }
  | { kind: "failed"; consecutiveFailures: number; reason: string };

export interface PluginDeliveryLoopDeps {
  db: DeliveryDb;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch | undefined;
  /** Injectable clock — every timestamp this loop reads/writes derives
   *  from this, never a bare `Date.now()` call scattered through the
   *  logic, so tests can drive gap/backoff/retention behavior
   *  deterministically. */
  now?: () => number;
  random?: () => number;
  pollIntervalMs?: number;
  onTick?: (pluginId: string, outcome: DeliveryTickOutcome) => void;
}

/** Resolved defaults, threaded through every helper below instead of each
 *  one re-reading `deps` and re-defaulting independently. */
interface ResolvedDeps {
  db: DeliveryDb;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch | undefined;
  now: () => number;
  random: () => number;
}

function resolveDeps(deps: PluginDeliveryLoopDeps): ResolvedDeps {
  return {
    db: deps.db,
    env: deps.env ?? process.env,
    fetchImpl: deps.fetchImpl,
    now: deps.now ?? Date.now,
    random: deps.random ?? Math.random,
  };
}

/**
 * Mirrors apps/worker/src/metadata/plugin-provider.ts's
 * maybeDisableOnBreakerTrip EXACTLY: fires ONLY on the exact call whose
 * breaker-counted failure trips closed/half-open -> open (a before/after
 * `snapshot().state` diff — callPlugin owns the admission/outcome
 * bookkeeping itself via `opts.breaker`, this function only OBSERVES the
 * transition callPlugin already made). Best-effort: a DB write failure
 * here is logged and swallowed, never rethrown — the delivery loop's own
 * `failed` outcome for this tick is what the caller ultimately reports.
 */
async function maybeDisableOnBreakerTrip(
  deps: ResolvedDeps,
  plugin: EventSubscriberPlugin,
  breaker: PluginCircuitBreaker,
  beforeState: string,
  nowMs: number,
): Promise<boolean> {
  const after = breaker.snapshot();
  const justTripped = beforeState !== "open" && after.state === "open";
  if (!justTripped) return false;

  try {
    await setPluginEnabledAndEmit(deps.db, {
      pluginId: plugin.id,
      enabled: false,
      reason: "breaker",
      actorUserId: null,
      nowMs,
    });
    await setPluginHealthAndEmit(deps.db, {
      pluginId: plugin.id,
      healthState: "unhealthy",
      consecutiveFailures: after.consecutiveFailures,
      ok: false,
      checkedAtMs: nowMs,
    });
  } catch (err) {
    console.error(
      `plugin-delivery: plugin "${plugin.id}" tripped its circuit breaker but the DB disable/health write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return true;
}

/**
 * Runs exactly one delivery attempt for one plugin. Pure orchestration —
 * every DB/network effect goes through the imported functions above, none
 * of it duplicated here. Exported (not just used internally by runOnce)
 * so tests can drive a single plugin's tick deterministically without a
 * live poll timer — accepts the same friendly, mostly-optional
 * `PluginDeliveryLoopDeps` shape startPluginDeliveryLoop does (defaults
 * resolved internally via resolveDeps).
 */
export async function deliverOnePluginTick(
  rawDeps: PluginDeliveryLoopDeps,
  plugin: EventSubscriberPlugin,
  breaker: PluginCircuitBreaker,
): Promise<DeliveryTickOutcome> {
  const deps = resolveDeps(rawDeps);
  const { db } = deps;
  const nowMs = deps.now();

  const capability = extractEventSubscriberCapability(plugin.manifest);
  if (!capability) {
    console.warn(`plugin-delivery: plugin "${plugin.id}" has no valid event-subscriber capability entry in its manifest — skipping`);
    return { kind: "invalid-manifest" };
  }

  const cursorRow = await getDeliveryCursor(db, plugin.id);
  if (cursorRow && !isRetryDue(cursorRow.consecutive_failures, cursorRow.last_attempt_ms, nowMs, deps.random)) {
    return { kind: "backoff-wait" };
  }

  // H-4 fix wave, defense in depth (constants.ts's own header): even though
  // a plugin_event_grants row for an admin-only type can no longer be
  // CREATED (apps/server/src/plugins/event-taxonomy.ts's registration-time
  // exclusion), this loop never fans one out either, independent of that
  // upstream gate. (Count deliberately unstated — the canonical inventory
  // lives in @loombre/shared admin-only-event-types; L3/Lane-R lesson:
  // counts in prose re-stale on every addition.)
  const grantedTypes = plugin.grantedTypes.filter((t) => !LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES.includes(t));

  const windowStartMs = nowMs - LPP_DELIVERY_RETENTION_WINDOW_MS;
  // `baseAfterId` stays id-shaped and drives ONLY findOldestUnconsumedBeforeMs
  // below (gap detection compares against ts_ms, which `seq` cannot help
  // with — migrations/0040_plugin_delivery_cursor_seq.sql's header). The
  // actual candidate read (listCandidateEventsForDelivery) keysets on
  // `baseAfterSeq` instead — see that function's doc comment for the
  // persisted-cursor same-millisecond skip hazard this fixes.
  const baseAfterId = cursorRow?.cursor_event_id ?? EPOCH_ZERO_BOUNDARY_UUID;
  const baseAfterSeq = cursorRow?.cursor_event_seq ?? 0;

  const gapOldestMs = await findOldestUnconsumedBeforeMs(db, {
    afterId: baseAfterId,
    grantedTypes,
    beforeMs: windowStartMs,
  });

  // When a gap is detected, `minTsMs` (not a replaced cursor) tells the
  // candidate read to skip straight past the gapped region to the window
  // edge, without ever touching `baseAfterSeq` itself — the gap is
  // reported (pendingGapReport below), never silently folded into an
  // advanced cursor.
  let minTsMs: number | undefined;
  let pendingGapReport: LppGapReport | null = null;
  if (gapOldestMs !== null) {
    minTsMs = windowStartMs;
    const fromMs = cursorRow?.gap_reported_through_ms ?? gapOldestMs;
    pendingGapReport = {
      detectedAtMs: nowMs,
      gaps: [{ fromMs, toMs: windowStartMs, reason: "retention-window-exceeded" }],
    };
  }

  const rawCandidates = await listCandidateEventsForDelivery(db, {
    afterSeq: baseAfterSeq,
    grantedTypes,
    limit: LPP_DELIVERY_BATCH_MAX,
    ...(minTsMs !== undefined ? { minTsMs } : {}),
  });

  if (rawCandidates.length === 0) {
    // Nothing to do this tick at all — including no gap to persist (a gap
    // is only ever persisted alongside a real shipped batch, see this
    // file's header). No DB write happens here on purpose.
    return { kind: "skip-empty" };
  }

  const rawLastId = rawCandidates[rawCandidates.length - 1]!.id;
  const rawLastSeq = rawCandidates[rawCandidates.length - 1]!.seq;

  let deliverable = rawCandidates;
  // H-2 fix wave: gate on the event-subscriber CAPABILITY's own
  // contentClass (parsed straight off this manifest, above), never the
  // plugin's aggregate plugins.content_class column — see
  // clearance.ts's pluginMayReceiveRestricted doc comment.
  if (!pluginMayReceiveRestricted(capability)) {
    const ctx = await buildGeneralSubscriberViewerContext(db);
    const survivorRows = await filterEventsForViewer(
      db,
      ctx,
      rawCandidates.map((e) => e.id),
    );
    const survivorIds = new Set(survivorRows.map((r) => r.id));
    deliverable = rawCandidates.filter((e) => survivorIds.has(e.id));
  }
  // restricted-scoped subscribers: deliverable === rawCandidates, unfiltered.

  if (deliverable.length === 0) {
    // Every candidate in this raw page was clearance-filtered out for a
    // general-scoped subscriber. Advance the cursor past the RAW page
    // anyway (see advanceCursorPastFilteredEvents's doc comment) so this
    // plugin is never stuck re-fetching an all-restricted page forever.
    // A gap, if one was detected, stays unreported this tick (nothing
    // shipped) — recomputed fresh next tick, per this file's header.
    await advanceCursorPastFilteredEvents(db, { pluginId: plugin.id, cursorEventId: rawLastId, cursorEventSeq: rawLastSeq, nowMs });
    return { kind: "advanced-no-content", rawCount: rawCandidates.length };
  }

  let salt: string | null = plugin.pseudonymSalt;
  if (plugin.pseudonymizeActorIds && !salt) {
    salt = await ensurePseudonymSalt(db, plugin.id);
  }

  const batch: LppEventBatch = {
    batchId: uuidv7(nowMs),
    events: deliverable.map((e) => ({
      id: e.id,
      type: e.type,
      occurredAtMs: e.tsMs,
      payload: pseudonymizePayload(e.type, e.payload, { pseudonymizeActorIds: plugin.pseudonymizeActorIds, salt }),
    })),
    gapReport: pendingGapReport,
  };

  const validated = LppEventBatchSchema.safeParse(batch);
  if (!validated.success) {
    // Should never happen (this loop builds every field itself against
    // the same frozen schema) — a HOST bug, not a plugin problem. Log
    // loudly, do not persist anything (retried fresh next tick), never
    // crash the loop (C6).
    console.error(`plugin-delivery: internally-built batch for plugin "${plugin.id}" failed LppEventBatchSchema validation:`, validated.error.issues);
    return { kind: "invalid-batch-internal-error" };
  }
  const bodyJson = JSON.stringify(validated.data);

  const secret = await resolvePluginHmacSecret(plugin.id, deps.env);
  if (!secret) {
    await recordDeliveryFailure(db, { pluginId: plugin.id, nowMs });
    return { kind: "no-secret" };
  }

  const signature = signLppBatch(secret, nowMs, bodyJson);
  let url: string;
  try {
    url = resolveDeliveryUrl(plugin.baseUrl, capability);
  } catch (err) {
    // H-5 fix wave: the frozen path regex now rejects a protocol-relative
    // endpoint at manifest-parse time, so this should be unreachable for
    // any plugin registered/refreshed after this fix — this catch exists
    // for a manifest snapshot stored BEFORE the narrowing landed. Never
    // ships the batch; recorded as an ordinary delivery failure (this
    // plugin's own backoff paces retries), never a breaker-counted one
    // (this is a host-side/manifest-shape rejection, not the plugin failing
    // to respond — same reasoning BREAKER_COUNTED_REASONS excludes
    // disallowed-address/dns-resolution-failed).
    if (err instanceof PluginEndpointOriginMismatchError) {
      console.error(`plugin-delivery: plugin "${plugin.id}": ${err.message}`);
      await recordDeliveryFailure(db, { pluginId: plugin.id, nowMs });
      return { kind: "failed", consecutiveFailures: 0, reason: "endpoint-origin-mismatch" };
    }
    throw err;
  }
  const beforeState = breaker.snapshot().state;

  // M-1 fix wave: inject X-LPP-Config + X-LPP-Secret-* exactly like every
  // OTHER plugin call (metadata-provider search/details/images) — the
  // frozen spec's own words: "whenever the host calls a plugin, it resolves
  // that plugin's current config values and injects them per request, via
  // headers, so plugins remain stateless." Before this fix, a delivery
  // carried ONLY content-type + the signature — the reference notifier's
  // own config secret (its configured webhook URL) never arrived, so it
  // silently took its "no-forward" degrade branch on EVERY delivery; this
  // was previously (mis)read as the notifier "gracefully degrading", but a
  // reference plugin that can never actually forward in production is the
  // real bug.
  const secretFieldNames = (() => {
    const parsedConfigSchema = LppConfigSchema.safeParse((plugin.manifest as { configSchema?: unknown }).configSchema);
    return parsedConfigSchema.success ? listTopLevelSecretFieldNames(parsedConfigSchema.data) : [];
  })();
  const configSecrets = await resolvePluginConfigSecrets(plugin.id, secretFieldNames, deps.env);
  const configHeaders = buildPluginRequestHeaders(plugin.config, configSecrets);

  let result: Awaited<ReturnType<typeof callPlugin>>;
  try {
    result = await callPlugin(
      url,
      { method: "POST", headers: { ...configHeaders, "X-LPP-Signature": signature }, body: bodyJson },
      {
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        clock: deps.now,
        timeoutMs: LPP_DELIVERY_TIMEOUT_MS,
        maxResponseBytes: LPP_CAPABILITY_MAX_RESPONSE_BYTES,
        lanAllowlist: plugin.lanAllowlist,
        breaker,
      },
    );
  } catch (err) {
    // H-3 fix wave, defense in depth: callPlugin's own contract is "never
    // throws for an ordinary failure mode" (hardened this same fix wave in
    // packages/plugin-host) — this catch exists purely so a host bug there
    // (or an entirely unanticipated throw) can never unwind past this
    // loop's failure recording, which is exactly the H-3 failure mode: a
    // throw that skips recordDeliveryFailure/the breaker leaves
    // plugin_delivery_cursors.consecutive_failures at 0 forever — no
    // backoff, retried every poll, and the plugin never auto-disables.
    breaker.onFailure(nowMs);
    const justTripped = await maybeDisableOnBreakerTrip(deps, plugin, breaker, beforeState, nowMs);
    if (justTripped) {
      return { kind: "breaker-tripped" };
    }
    const { consecutiveFailures } = await recordDeliveryFailure(db, { pluginId: plugin.id, nowMs });
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`plugin-delivery: plugin "${plugin.id}" delivery call threw unexpectedly (should be impossible): ${detail}`);
    return { kind: "failed", consecutiveFailures, reason: "network-error" };
  }

  if (!result.ok) {
    if (result.reason === "circuit-open") {
      // Breaker already open from a PRIOR trip — no HTTP attempt was made
      // at all. The plugin should already be disabled in the DB (this
      // loop disables synchronously at the exact trip moment below), so
      // it will drop out of listEventSubscriberPlugins on the next tick;
      // nothing to persist here.
      return { kind: "circuit-open" };
    }
    const { consecutiveFailures } = await recordDeliveryFailure(db, { pluginId: plugin.id, nowMs });
    if (BREAKER_COUNTED_REASONS.includes(result.reason)) {
      const justTripped = await maybeDisableOnBreakerTrip(deps, plugin, breaker, beforeState, nowMs);
      if (justTripped) {
        return { kind: "breaker-tripped" };
      }
    }
    return { kind: "failed", consecutiveFailures, reason: result.reason };
  }

  if (result.status < 200 || result.status >= 300) {
    // M-8 fix wave: callPlugin itself now records a non-2xx status as a
    // breaker FAILURE (not a success) — see @loombre/plugin-host/src/
    // call-plugin.ts's header. This lane's own backoff counts it too,
    // independent of that shared breaker signal.
    const { consecutiveFailures } = await recordDeliveryFailure(db, { pluginId: plugin.id, nowMs });
    return { kind: "failed", consecutiveFailures, reason: `http-${result.status}` };
  }

  await recordDeliverySuccess(db, {
    pluginId: plugin.id,
    cursorEventId: rawLastId,
    cursorEventSeq: rawLastSeq,
    deliveredEventCount: deliverable.length,
    nowMs,
    ...(pendingGapReport ? { gapReportedThroughMs: windowStartMs } : {}),
  });
  return { kind: "delivered", count: deliverable.length, gapReported: pendingGapReport !== null };
}

export interface PluginDeliveryLoopHandle {
  stop(): Promise<void>;
  /** Test/ops seam: runs exactly one poll tick across every CURRENT
   *  subscriber plugin, resolving once every plugin's attempt for this
   *  tick has settled (never rejects — a single plugin's thrown error is
   *  caught and logged, per-plugin isolation holds even against a bug in
   *  this loop itself, not just against a slow/broken plugin endpoint). */
  runOnce(): Promise<void>;
}

/**
 * Starts the delivery loop: a plain poll interval (LPP_DELIVERY_POLL_
 * INTERVAL_MS — no LISTEN/NOTIFY wake-up, see constants.ts's header for
 * why that's this lane's unpinned choice) that calls runOnce() on a
 * timer. Overlap-guarded (a tick that runs long never starts a second
 * one on top of itself) and clean-shutdown (stop() waits for any in-flight
 * tick to finish before resolving, so a worker shutdown can never
 * interrupt a batch between "2xx received" and "cursor persisted").
 */
export function startPluginDeliveryLoop(deps: PluginDeliveryLoopDeps): PluginDeliveryLoopHandle {
  const resolved = resolveDeps(deps);
  const breakers = new Map<string, PluginCircuitBreaker>();
  let ticking = false;
  let stopped = false;

  async function runOnce(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const plugins = await listEventSubscriberPlugins(resolved.db);
      await Promise.allSettled(
        plugins.map(async (plugin) => {
          let breaker = breakers.get(plugin.id);
          if (!breaker) {
            // C5.1 fix wave (closes deferred LPP L-5, worker-side — mirrors
            // apps/server/src/plugins/plugin-health.service.ts's identical
            // fix): seed this breaker's failure count from the durable
            // plugins.consecutive_failures counter on its FIRST
            // construction — effectively "at boot" for this lazily-built
            // per-loop-instance map — so a worker restart mid-window (or
            // another process, e.g. apps/server's periodic health check,
            // having already recorded failures for a plugin this loop
            // instance has never delivered to yet) is not silently
            // discarded. listEventSubscriberPlugins' own narrow projection
            // (EventSubscriberPlugin) does not carry consecutive_failures,
            // so this is the ONE extra read — bounded by plugin count, not
            // by poll tick, since it only runs on a breaker's first
            // construction per process lifetime.
            const seedAtMs = resolved.now();
            const durable = await getPluginById(resolved.db, plugin.id);
            breaker = new PluginCircuitBreaker(
              durable ? { seed: { consecutiveFailures: durable.consecutive_failures, atMs: seedAtMs } } : {},
            );
            breakers.set(plugin.id, breaker);
          }
          try {
            const outcome = await deliverOnePluginTick(resolved, plugin, breaker);
            deps.onTick?.(plugin.id, outcome);
          } catch (err) {
            console.error(`plugin-delivery: unhandled error delivering to plugin ${plugin.id}:`, err);
          }
        }),
      );
    } catch (err) {
      // AUD-A2e-001 fix wave: listEventSubscriberPlugins is the ONE DB call
      // in this function outside the per-plugin Promise.allSettled map
      // above, so it was the one gap in this loop's own documented "never
      // rejects" contract (see PluginDeliveryLoopHandle.runOnce's doc
      // comment below). Below, the poll timer invokes runOnce() as a bare
      // `void runOnce()` — an uncaught rejection here would become an
      // unhandledRejection -> apps/worker/src/crash/handlers.ts's onFatal
      // -> process.exit(1), killing every OTHER consumer sharing this
      // worker process over a single transient failure (pool exhaustion,
      // connection reset, an embedded-Postgres restart). Same shape as the
      // per-plugin catch just above: log and let this tick end early — no
      // new backoff invented (backoff.ts's consecutive_failures pacing is
      // keyed per-plugin and has no row to attribute this failure to); the
      // existing poll interval below is already this failure's retry
      // pacing, unchanged.
      console.error(`plugin-delivery: runOnce tick failed listing event-subscriber plugins: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      ticking = false;
    }
  }

  const interval = setInterval(() => {
    void runOnce();
  }, deps.pollIntervalMs ?? LPP_DELIVERY_POLL_INTERVAL_MS);

  return {
    runOnce,
    async stop() {
      stopped = true;
      clearInterval(interval);
      while (ticking) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

export type { DeliveryDb } from "./clearance.js";
