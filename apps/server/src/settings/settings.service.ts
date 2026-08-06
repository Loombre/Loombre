// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/settings/settings.service.ts
//
// STATE.md Addendum A — the settings core's NestJS-facing half: boot load,
// validation report (loud console log — A4's "REPORTED at boot" admin-
// notice mechanism), an in-memory cache of the resolved effective values,
// a typed in-process hot-reload emitter (A5), restart-pending tracking
// (A5), and the admin-facing mutation path S2 wires PUT /v1/admin/
// settings/{key} to (A10's live isAdmin re-verify + A8's env-pin lockout +
// schema validation + the transactional outbox write, in that order).
//
// Every decision RULE (env > database > default precedence, restart-pending
// diffing) is delegated to packages/shared/src/settings-resolve.ts's pure
// functions — this class is orchestration (when to call them, what to do
// with a DB handle, who to notify) around logic that is itself unit-tested
// with zero I/O in packages/shared/test/.
//
// Not wired into AppModule by this lane (S2 owns the controllers this
// service backs, and imports SettingsModule wherever those controllers
// live) — see this lane's final report for why: wiring a live boot-time DB
// read into every apps/server test suite that boots the full app is a
// blast-radius decision that belongs to whoever is actually adding the
// route, not to the lane that only builds the service.
//
// Security review F1 (the headline finding): GET /v1/admin/settings and GET
// /v1/admin/settings/schema were previously gated by the WEAKER claim-based
// requireAdmin() (apps/server/src/settings/admin-settings.controller.ts) —
// a demoted admin's still-live access token could read database.url's
// EFFECTIVE VALUE (the Postgres password inline in the connection string)
// for up to the token's remaining lifetime. Both GETs now call
// assertLiveAdmin() below (the same fresh DB re-read updateSetting() always
// used) FIRST, before touching the registry at all. Independently,
// toAdminSettingsResponse/toSchemaResponse mask the credential portion of
// any entry.secret:true value (packages/shared/src/settings-registry.ts's
// `secret` flag) — belt-and-braces: even a genuinely-live admin never sees
// the raw credential over this surface.

import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import {
  SETTINGS_REGISTRY,
  SETTINGS_REGISTRY_BY_KEY,
  computeRestartPendingKeys,
  registryDefaultForTier,
  resolveEffectiveSettings,
  settingsValueJsonSchema,
  snapshotRestartSensitiveValues,
  type EffectiveSettingValue,
  type ResolveEffectiveSettingsResult,
  type SettingsResolutionNotice,
  type SettingsTier,
} from "@loombre/shared";
import { listServerSettings, upsertServerSettingAndEmit } from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import { conflict, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import type {
  AdminSettingSchemaEntryDto,
  AdminSettingValueDto,
  AdminSettingsResponseDto,
  AdminSettingsSchemaResponseDto,
  MailCredentialsStatusDto,
  ProviderKeyStatusDto,
  UpdateSettingResponseDto,
} from "./settings.types.js";

export interface SettingsChangedEvent {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  actorUserId: string;
  nowMs: number;
}

export type SettingsChangeListener = (event: SettingsChangedEvent) => void;

export interface UpdateSettingInput {
  key: string;
  value: unknown;
  actorUserId: string;
  nowMs: number;
  /** RFC 9457 `instance` for any thrown ProblemException — defaults to a
   *  synthetic `/v1/admin/settings/{key}` path when the caller (a real
   *  controller) doesn't supply the actual request path. */
  instancePath?: string;
}

/** Mirrors apps/server/src/playback/resolve-policy.ts's parseEnvTier
 *  exactly, duplicated deliberately rather than imported: this module has
 *  no other reason to depend on playback/, and the function is three
 *  lines — see this lane's report for why a same-named cross-import was
 *  avoided even though dependency-cruiser's D2 pairwise ban does not
 *  actually cover a NEW module importing FROM playback/ (only the three
 *  named pairwise directions are forbidden). */
function resolveTier(env: NodeJS.ProcessEnv): SettingsTier {
  const raw = env["LOOMBRE_TIER"];
  if (raw === "1") return 1;
  if (raw === "2") return 2;
  return 0;
}

/**
 * Security review F1: masks the credential portion of a `secret:true`
 * registry entry's value (today, only database.url) before it is ever
 * serialized onto the wire — never the raw credential, not even to a
 * live-verified admin. Generic over any `scheme://user:pass@host/...`
 * shaped string; a value that doesn't match that shape (no `@`, or not a
 * string at all) is masked in full rather than risking a partial leak.
 * Exported for direct unit-test coverage of the masking shape itself.
 *
 * Deliberately returns a STRING placeholder (never `undefined`/omits the
 * key) — packages/contract/openapi.yaml's AdminSettingValue/
 * AdminSettingSchemaEntry schemas both mark `value`/`default` as required
 * properties (additionalProperties: false, required: [...]); omitting the
 * key entirely would itself be a contract violation. A masked string
 * satisfies the frozen wire shape while never carrying the secret.
 */
// V1-003: a `scheme://user:pass@host` authority must be split on the LAST
// "@", not the first — WHATWG URL parsing splits there (verified against
// pg-connection-string, which also accepts a literal "@" in a password), so
// a password containing "@" is a fully working configuration whose tail
// leaked past a first-"@" split. The authority is only the part BEFORE the
// first "/" (a host can never contain "@"); credentials, once found, are
// split on the FIRST ":" (a username is never expected to carry one).
const SCHEME_PREFIX_RE = /^[a-zA-Z][\w+.-]*:\/\//;

export function maskSecretValue(value: unknown): unknown {
  if (typeof value !== "string") return "***";
  const schemeMatch = value.match(SCHEME_PREFIX_RE);
  if (!schemeMatch) return "***";
  const schemePrefix = schemeMatch[0];
  const afterScheme = value.slice(schemePrefix.length);
  const pathIdx = afterScheme.indexOf("/");
  const authority = pathIdx === -1 ? afterScheme : afterScheme.slice(0, pathIdx);
  const pathAndRest = pathIdx === -1 ? "" : afterScheme.slice(pathIdx);
  const atIdx = authority.lastIndexOf("@");
  if (atIdx === -1) return "***";
  const userinfo = authority.slice(0, atIdx);
  const host = authority.slice(atIdx + 1);
  const colonIdx = userinfo.indexOf(":");
  const maskedUserinfo = colonIdx === -1 ? userinfo : `${userinfo.slice(0, colonIdx)}:***`;
  return `${schemePrefix}${maskedUserinfo}@${host}${pathAndRest}`;
}

@Injectable()
export class SettingsService implements OnApplicationBootstrap {
  private resolution: ResolveEffectiveSettingsResult | undefined;
  private bootSnapshot: Record<string, unknown> = {};
  private readonly listeners = new Set<SettingsChangeListener>();

  /** @internal Test seam (orchestrator, Addendum A wave-2 integration): the
   *  registry this instance resolves against. Public only so tests outside
   *  this class's own file can reach it before bootstrap() — never intended
   *  for production call sites to read or write; production always uses the
   *  real SETTINGS_REGISTRY (a field, not a constructor param, because Nest
   *  reflects every ctor param for DI and would refuse to boot on an
   *  uninjectable array token). Tests may override BEFORE bootstrap() to
   *  prove restart-pending semantics: after lane S3's hot-reload
   *  migration, ZERO real entries carry requiresRestart:true, so the
   *  snapshot/pending machinery is only exercisable with a synthetic
   *  entry — the mechanism must stay proven for the first future key that
   *  genuinely cannot hot-apply. */
  registry: readonly (typeof SETTINGS_REGISTRY)[number][] = SETTINGS_REGISTRY;

  constructor(private readonly dbProvider: DbProvider) {}

  private get registryByKey(): ReadonlyMap<string, (typeof SETTINGS_REGISTRY)[number]> {
    return this.registry === SETTINGS_REGISTRY
      ? SETTINGS_REGISTRY_BY_KEY
      : new Map(this.registry.map((entry) => [entry.key, entry]));
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.bootstrap();
  }

  /**
   * Loads server_settings + resolves effective values. The boot-time
   * restart-pending snapshot (A5) is captured only the FIRST time this
   * runs for this instance — later calls (reload() below, or a repeated
   * bootstrap()) refresh the cache without moving the snapshot, which
   * would defeat the entire point of "pending" (it must diff against boot,
   * not against "a moment ago").
   */
  async bootstrap(): Promise<ResolveEffectiveSettingsResult> {
    const isFirstLoad = this.resolution === undefined;
    const result = await this.reload();
    if (isFirstLoad) {
      this.bootSnapshot = snapshotRestartSensitiveValues(this.registry, result.values);
    }
    return result;
  }

  /** Refreshes the cache from the current DB rows + env, WITHOUT touching
   *  the boot snapshot. Called after every successful mutation (hot-reload
   *  consumers then see the new effective value on their next read) and
   *  safe to call as often as needed. */
  async reload(): Promise<ResolveEffectiveSettingsResult> {
    // An UNMIGRATED database (no server_settings relation yet — Postgres
    // 42P01 undefined_table) resolves as zero rows + a loud admin notice,
    // never a crash. The documented install flows (docs/install/docker.md:
    // "healthy with an unmigrated database is expected, not a bug") boot
    // the server BEFORE the operator runs migrate; pre-Addendum-A the
    // server made no boot-time table reads, and the addendum's own A4 law
    // ("default + notice, never crash") extends naturally from invalid
    // VALUES to a missing TABLE. Every setting resolves from env/default —
    // exactly what an empty, freshly-migrated table would produce — and
    // the first successful mutation or reload after migration picks up
    // real rows. Any OTHER database error still throws (a down/misgranted
    // DB must stay loud).
    let rows: Awaited<ReturnType<typeof listServerSettings>>;
    try {
      rows = await listServerSettings(this.dbProvider.db);
    } catch (error) {
      if ((error as { code?: unknown })?.code === "42P01") {
        console.warn(
          "@loombre/server settings: server_settings relation does not exist (database not migrated yet) — " +
            "every setting resolves from env/default until migrations run. ADMIN NOTICE.",
        );
        rows = [];
      } else {
        throw error;
      }
    }
    const tier = resolveTier(process.env);
    const result = resolveEffectiveSettings(
      this.registry,
      process.env,
      rows.map((row) => ({ key: row.key, value: row.value })),
      { tier },
    );

    // A4: "unknown rows REPORTED at boot (loud log + admin-notice
    // mechanism), never silently dropped" — the loud log half lives here;
    // the admin-notice half is `this.notices`/`this.unknownDbKeys` below,
    // which a future admin-facing endpoint (S2) can surface verbatim.
    for (const key of result.unknownDbKeys) {
      console.warn(
        `@loombre/server settings: server_settings row "${key}" does not match any registered setting — preserved untouched, never applied. ADMIN NOTICE.`,
      );
    }
    for (const notice of result.notices) {
      console.warn(
        `@loombre/server settings: invalid ${notice.source} value for "${notice.key}" (${notice.reason}) — falling back to the next-lower-precedence source, never crashing. ADMIN NOTICE.`,
      );
    }

    this.resolution = result;
    return result;
  }

  private requireLoaded(): ResolveEffectiveSettingsResult {
    if (!this.resolution) {
      throw new Error("SettingsService: bootstrap()/reload() must run before any read — no cache loaded yet.");
    }
    return this.resolution;
  }

  getEffective(key: string): EffectiveSettingValue | undefined {
    return this.requireLoaded().values[key];
  }

  getAllEffective(): Readonly<Record<string, EffectiveSettingValue>> {
    return this.requireLoaded().values;
  }

  get notices(): readonly SettingsResolutionNotice[] {
    return this.requireLoaded().notices;
  }

  get unknownDbKeys(): readonly string[] {
    return this.requireLoaded().unknownDbKeys;
  }

  /** A5: keys whose CURRENT effective value differs from its boot-time
   *  snapshot — restricted to requiresRestart:true entries by construction
   *  (computeRestartPendingKeys). */
  get restartPendingKeys(): string[] {
    return computeRestartPendingKeys(this.registry, this.bootSnapshot, this.requireLoaded().values);
  }

  /** A5: "Hot-reload consumers subscribe in-process (typed emitter in the
   *  service)." Returns an unsubscribe function rather than requiring the
   *  caller to hold onto the original listener reference. */
  onChange(listener: SettingsChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(event: SettingsChangedEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Security review F1c: the shared A10 live-admin re-verify seam for the
   * two GET endpoints (previously claim-based requireAdmin() — see this
   * file's header). One await, same as updateSetting()'s own first line —
   * a fresh DB read of users.is_admin, never the possibly-stale (up to the
   * access token's 15-minute lifetime) `req.user.isAdmin` claim. Public so
   * apps/server/src/settings/admin-settings.controller.ts's two GET
   * handlers can call it without either duplicating requireLiveAdmin's
   * import or reaching past this service into DbProvider directly.
   */
  async assertLiveAdmin(actorUserId: string, instancePath: string): Promise<void> {
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);
  }

  /**
   * PUT /v1/admin/settings/{key} (S2 wires the controller). Order of
   * checks, each independently load-bearing:
   *   1. A10 live isAdmin re-verify (403) — FIRST, before this method
   *      leaks anything about whether `key` even exists.
   *   2. Unknown or non-UI (env-only) key (404) — A2/A8: env-only keys are
   *      never writable through this surface at all.
   *   3. Active env pin (409) — A8: env wins unconditionally; no submitted
   *      value can ever take effect while the pin is set, regardless of
   *      whether that value would otherwise be valid.
   *   4. Schema validation (422), including the D13/A3 majority-age floor
   *      (enforced twice: registry schema's .min(18), and the explicit
   *      redundant check below — "enforced in schema AND service").
   *   5. Security review F9 cross-field validation (422): two key PAIRS
   *      whose valid RANGE depends on each other's value, which a single
   *      key's zod schema cannot express on its own —
   *      transcode.segmentAheadResumeThreshold < segmentAheadSuspendThreshold,
   *      and sessions.staleCutoffMs > sessions.heartbeatSuspendCutoffMs.
   *      Whichever key of a pair is being written is checked against the
   *      OTHER key's CURRENT effective value (this call never touches the
   *      other key). Runs after per-key schema validation so its error
   *      message can safely quote a schema-valid submitted number.
   *      RG12 (STATE.md "Loombre Remote..."): a THIRD relationship, same
   *      shape — tls.mode may only BE (or become) "acme" while
   *      tls.acmeDomains is non-empty AND tls.acmeTosAgreed is true (the
   *      exact preconditions apps/server/src/tls/config.ts's loadTlsConfig
   *      throws a TlsConfigError over at boot if unmet); the two ACME keys
   *      may not be written into a state that breaks an ALREADY-acme
   *      tls.mode either — a settings-screen edit must never be able to
   *      produce a boot-time lockout the way a raw env-var typo could.
   *   6. Transactional write + outbox emission, cache reload, hot-reload
   *      notification.
   */
  async updateSetting(input: UpdateSettingInput): Promise<UpdateSettingResponseDto> {
    const instancePath = input.instancePath ?? `/v1/admin/settings/${input.key}`;

    await requireLiveAdmin(this.dbProvider.db, input.actorUserId, instancePath);

    const entry = this.registryByKey.get(input.key);
    if (!entry || entry.scope !== "ui") {
      throw notFound("Unknown or non-editable settings key.", instancePath);
    }

    const current = this.getEffective(input.key);
    if (current?.locked) {
      throw conflict(
        `This setting is currently pinned by its environment variable (${current.lockedBy}) and cannot be changed through the API. Remove ${current.lockedBy} from the environment and restart to make it editable here.`,
        instancePath,
      );
    }

    const parsed = entry.schema.safeParse(input.value);
    if (!parsed.success) {
      throw unprocessableEntity(
        `Invalid value for "${input.key}": ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        instancePath,
      );
    }

    // D13/A3 redundant service-layer floor — see this method's doc comment.
    // Unreachable today given the schema's own .min(18), by design: this is
    // the documented SECOND enforcement point, not a substitute for the
    // first.
    if (input.key === "restricted.majorityAgeYears" && typeof parsed.data === "number" && parsed.data < 18) {
      throw unprocessableEntity("restricted.majorityAgeYears may never be set below 18.", instancePath);
    }

    this.assertCrossFieldInvariants(input.key, parsed.data, instancePath);

    const { oldValue } = await upsertServerSettingAndEmit(this.dbProvider.db, {
      key: input.key,
      value: parsed.data,
      actorUserId: input.actorUserId,
      nowMs: input.nowMs,
    });

    await this.reload();

    this.emitChange({
      key: input.key,
      oldValue,
      newValue: parsed.data,
      actorUserId: input.actorUserId,
      nowMs: input.nowMs,
    });

    const effective = this.getEffective(input.key)!;
    return {
      key: input.key,
      value: effective.value,
      source: effective.source,
      requiresRestart: effective.requiresRestart,
      restartPending: this.restartPendingKeys.includes(input.key),
    };
  }

  /**
   * Security review F9: registry-level bounds (min/max on a single key's
   * own zod schema) cannot express a relationship BETWEEN two keys. Two
   * such pairs exist today; both are checked here, AFTER per-key schema
   * validation (updateSetting()'s step 5) and BEFORE the write. Whichever
   * key of a pair `writtenKey` is validates its schema-parsed `writtenValue`
   * against the OTHER key's CURRENT effective value — this never reads or
   * writes the other key itself, so writing either half of a pair alone is
   * always possible as long as the resulting pair stays valid.
   */
  private assertCrossFieldInvariants(writtenKey: string, writtenValue: unknown, instancePath: string): void {
    const otherEffectiveNumber = (key: string): number => this.getEffective(key)!.value as number;

    if (writtenKey === "transcode.segmentAheadResumeThreshold" || writtenKey === "transcode.segmentAheadSuspendThreshold") {
      const resumeValue =
        writtenKey === "transcode.segmentAheadResumeThreshold"
          ? (writtenValue as number)
          : otherEffectiveNumber("transcode.segmentAheadResumeThreshold");
      const suspendValue =
        writtenKey === "transcode.segmentAheadSuspendThreshold"
          ? (writtenValue as number)
          : otherEffectiveNumber("transcode.segmentAheadSuspendThreshold");
      if (!(resumeValue < suspendValue)) {
        throw unprocessableEntity(
          `"transcode.segmentAheadResumeThreshold" (${resumeValue}) must be less than "transcode.segmentAheadSuspendThreshold" (${suspendValue}).`,
          instancePath,
        );
      }
    }

    if (writtenKey === "sessions.staleCutoffMs" || writtenKey === "sessions.heartbeatSuspendCutoffMs") {
      const staleValue =
        writtenKey === "sessions.staleCutoffMs" ? (writtenValue as number) : otherEffectiveNumber("sessions.staleCutoffMs");
      const heartbeatValue =
        writtenKey === "sessions.heartbeatSuspendCutoffMs"
          ? (writtenValue as number)
          : otherEffectiveNumber("sessions.heartbeatSuspendCutoffMs");
      if (!(staleValue > heartbeatValue)) {
        throw unprocessableEntity(
          `"sessions.staleCutoffMs" (${staleValue}) must be greater than "sessions.heartbeatSuspendCutoffMs" (${heartbeatValue}).`,
          instancePath,
        );
      }
    }

    // RG12: tls.mode="acme" requires tls.acmeDomains non-empty AND
    // tls.acmeTosAgreed=true (see this method's doc comment) — checked
    // whichever of the three keys is being written, against the OTHER
    // two's CURRENT effective values, same three-way shape as the pairs
    // above extended to three participants instead of two.
    if (writtenKey === "tls.mode" || writtenKey === "tls.acmeDomains" || writtenKey === "tls.acmeTosAgreed") {
      const modeValue = writtenKey === "tls.mode" ? (writtenValue as string) : (this.getEffective("tls.mode")?.value as string);
      const domainsValue =
        writtenKey === "tls.acmeDomains" ? (writtenValue as string[]) : (this.getEffective("tls.acmeDomains")?.value as string[]);
      const tosAgreedValue =
        writtenKey === "tls.acmeTosAgreed" ? (writtenValue as boolean) : (this.getEffective("tls.acmeTosAgreed")?.value as boolean);

      if (modeValue === "acme") {
        if (!domainsValue || domainsValue.length === 0) {
          throw unprocessableEntity(
            '"tls.mode" cannot be "acme" while "tls.acmeDomains" is empty — set at least one domain first.',
            instancePath,
          );
        }
        if (!tosAgreedValue) {
          throw unprocessableEntity(
            '"tls.mode" cannot be "acme" while "tls.acmeTosAgreed" is not true — the certificate authority\'s Terms of Service must be accepted first.',
            instancePath,
          );
        }
      }
    }
  }

  // ============================================================================
  // Response shaping — S2's controllers call these and pass the result
  // through as the HTTP body verbatim (settings.types.ts's frozen DTOs).
  // ============================================================================

  toAdminSettingsResponse(providerKeys: ProviderKeyStatusDto[], mailCredentials: MailCredentialsStatusDto): AdminSettingsResponseDto {
    const settings: AdminSettingValueDto[] = this.registry.map((entry) => {
      const effective = this.getEffective(entry.key);
      const rawValue = effective?.value;
      return {
        key: entry.key,
        value: entry.secret ? maskSecretValue(rawValue) : rawValue,
        source: effective?.source ?? "default",
        requiresRestart: entry.requiresRestart,
        locked: effective?.locked ?? false,
        ...(effective?.lockedBy !== undefined ? { lockedBy: effective.lockedBy } : {}),
      };
    });
    return { settings, restartPendingKeys: this.restartPendingKeys, providerKeys, mailCredentials };
  }

  toSchemaResponse(): AdminSettingsSchemaResponseDto {
    const entries: AdminSettingSchemaEntryDto[] = this.registry.map((entry) => {
      const effective = this.getEffective(entry.key);
      const tier = resolveTier(process.env);
      return {
        key: entry.key,
        category: entry.category,
        description: entry.description,
        ...(entry.caution !== undefined ? { caution: entry.caution } : {}),
        scope: entry.scope,
        requiresRestart: entry.requiresRestart,
        ...(entry.envVar !== undefined ? { envVar: entry.envVar } : {}),
        default: entry.secret ? maskSecretValue(registryDefaultForTier(entry, tier)) : registryDefaultForTier(entry, tier),
        valueSchema: settingsValueJsonSchema(entry),
        locked: effective?.locked ?? false,
        ...(effective?.lockedBy !== undefined ? { lockedBy: effective.lockedBy } : {}),
      };
    });
    return { entries };
  }
}
