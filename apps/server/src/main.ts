// SPDX-License-Identifier: AGPL-3.0-only
import "reflect-metadata";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { Express, NextFunction, Request, Response } from "express";
import { resolveJwtSecret } from "@loombre/secrets";
import { LOOMBRE_VERSION_FULL } from "@loombre/shared";
import { AppModule } from "./app.module.js";
import { applyHsts } from "./tls/hsts.js";
import { loadTlsConfig, type TlsConfig } from "./tls/config.js";
import { createTlsRuntime, type CreateTlsRuntimeOptions } from "./tls/runtime.js";
import { hydrateTlsEnvFromSettings } from "./tls/settings-boot-bridge.js";
import { bootstrapProvisioning, getProvisioningController } from "./bootstrap/provisioning.js";
import { wireServerIpc } from "./ipc/index.js";
import { resolveAppPaths } from "./cli/app-paths.js";
import { installCrashHandlers, installGracefulShutdown, type ShutdownSignal } from "./crash/index.js";
import { RESTART_REQUESTED_EXIT_CODE, ServerPowerService } from "./common/server-power.service.js";
import { SettingsService } from "./settings/settings.service.js";
import { WsUpgradeRegistry } from "./common/ws-upgrade.registry.js";
import { ConnectorManager } from "./remote/tunnel/connector-manager.js";

/**
 * LOOMBRE_TRUST_PROXY (STATE.md P2.2, docs/PLAN.md §10: "plain HTTP behind
 * a user's reverse proxy with trust-proxy config" is the documented v1
 * remote-access path — see README.md's "Remote access" section). OFF by
 * default: `req.ip` is the raw socket address and X-Forwarded-For is
 * ignored, so nothing a client sends can move the auth rate limiter's or
 * anomaly log's IP key. Only when an operator running behind their OWN
 * trusted reverse proxy explicitly sets this does Express start honoring
 * X-Forwarded-For for `req.ip`.
 *
 * Accepts exactly what Express's own `trust proxy` setting understands:
 * a boolean-like flag ("true"/"1"/"on"/"yes"), a hop count (bare integer),
 * or an Express preset/CIDR list ("loopback", "10.0.0.0/8", ...) passed
 * straight through unparsed. Falsy values ("0"/"false"/"off"/"no") and an
 * unset/empty var both resolve to `undefined`, meaning "leave Express's
 * default (disabled) alone" — `app.set()` is never called at all in that
 * case, rather than being called with a value that means "disabled",
 * since Express has no explicit off-value of its own to pass.
 */
export function resolveTrustProxySetting(raw: string | undefined): boolean | number | string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const lowered = trimmed.toLowerCase();
  if (lowered === "0" || lowered === "false" || lowered === "off" || lowered === "no") return undefined;
  if (lowered === "1" || lowered === "true" || lowered === "on" || lowered === "yes") return true;
  const asInt = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asInt) && String(asInt) === trimmed) return asInt;
  return trimmed;
}

/** Applies LOOMBRE_TRUST_PROXY to the underlying Express instance. Exported
 *  separately from `bootstrap()` so tests can drive it against an
 *  in-process app (via NestFactory.create + app.init()) the exact same way
 *  the real entrypoint does, without needing to invoke `bootstrap()`
 *  itself (which also binds a real port). */
export function applyTrustProxy(app: INestApplication, raw: string | undefined): void {
  const setting = resolveTrustProxySetting(raw);
  if (setting === undefined) return;
  (app.getHttpAdapter().getInstance() as Express).set("trust proxy", setting);
}

/**
 * LOOMBRE_CORS_ORIGINS (docs/PLAN.md §10 "strict CORS"): comma-separated
 * origin allowlist for the browser web client, which is cross-origin by
 * design (the login screen takes a server URL; Next dev serves the client
 * on its own port). Strict means: only exact listed origins are reflected,
 * no wildcard, no credentials (auth is Bearer/`?token=`, never cookies).
 * Default covers the local dev pairing only. Empty value disables CORS
 * entirely (same-origin deployments behind one reverse proxy).
 */
export function resolveCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return ["http://localhost:3000", "http://127.0.0.1:3000"];
  return raw
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => o.length > 0);
}

export function applyCors(app: INestApplication, raw: string | undefined): void {
  const origins = resolveCorsOrigins(raw);
  if (origins.length === 0) return;
  app.enableCors({
    origin: origins,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Retry-After", "ETag"],
    credentials: false,
    maxAge: 3600,
  });
}

/**
 * F2 (Wave-4 review, MED) + Phase 4 lane G1 deliverable 2 (helmet-equivalent
 * set): the server had no security headers at all, and tokens can
 * legitimately ride in query strings (P2.18's `?token=` media-fetch
 * fallback — see gateway/sanitize-instance.ts) with no Referrer-Policy to
 * stop them leaking via a Referer header on a subsequent cross-origin
 * request. Hand-set on every response (no `helmet` dep — this repo's
 * native-module/dep-weight posture and the small, closed header set below
 * don't justify one):
 *   - X-Content-Type-Options: nosniff — stops a browser from MIME-sniffing
 *     a response into executing as something other than its declared
 *     Content-Type (relevant here because images.controller.ts/
 *     session-file.controller.ts stream operator-supplied media bytes).
 *   - Referrer-Policy: no-referrer — the ?token= leak vector above: never
 *     send ANY Referer header cross-origin (or same-origin), full stop.
 *   - X-Frame-Options: DENY — this is an API, never meant to be framed;
 *     blocks classic clickjacking against any browser-reachable route.
 *   - Permissions-Policy: a minimal deny-list — this API never needs
 *     camera/microphone/geolocation itself, and disabling them here means
 *     ANY response this server serves (including a future served-web-build
 *     path, STATE.md's open "web-serving architecture" item) can't have
 *     those permissions silently delegated to it by an embedding page.
 *   - Cross-Origin-Resource-Policy: cross-origin — REQUIRED, not optional,
 *     because apps/web is a DIFFERENT origin from apps/server in the
 *     documented v1 deployment shape (the login screen takes an arbitrary
 *     server URL) and legitimately loads media via <img>/<video>/<audio>
 *     src= (P2.18). The unqualified default (no CORP header at all) is
 *     already permissive for simple `<img>`/`<video>` loads today, but an
 *     explicit `cross-origin` value future-proofs this against browsers
 *     tightening that default and is the correct, honest value for a
 *     resource that IS meant to be embedded cross-origin by design.
 *
 * COOP/COEP (task-mandated evaluation, decided + documented here rather
 * than silently applied or silently skipped):
 *   - Cross-Origin-Opener-Policy: same-origin IS applied below — it only
 *     affects window/opener relationships for top-level HTML documents,
 *     never subresource fetches, so it cannot break <img>/<video>/<audio>
 *     loading from apps/web and costs nothing today (defense in depth for
 *     any future HTML this server serves).
 *   - Cross-Origin-Embedder-Policy is DELIBERATELY NOT applied. COEP:
 *     require-corp would force EVERY cross-origin subresource a page
 *     embeds to carry a matching CORP/CORS header, and the web client's
 *     hls.js MSE/blob: media pipeline (STATE.md Phase 3's own "the P3
 *     lesson: it broke playback once" scar tissue on this exact media
 *     path) is not something this lane can verify end-to-end in a real
 *     browser this wave (RESOURCE ISOLATION: browser is orchestrator-
 *     owned). Enabling COEP here with no coordinated verification on the
 *     web side risks silently breaking video playback for zero current
 *     benefit — nothing in Loombre needs cross-origin isolation's actual
 *     payoff (SharedArrayBuffer) today. Revisit if/when a feature actually
 *     needs it, verified together with a real browser pass.
 * Registered as Express middleware (app.use), which runs for every
 * request/response pair including error responses ProblemJsonExceptionFilter
 * produces — unlike a NestJS interceptor, middleware always runs even when
 * a filter short-circuits the normal handler pipeline.
 */
export function applySecurityHeaders(app: INestApplication): void {
  const httpAdapter = app.getHttpAdapter().getInstance() as Express;
  httpAdapter.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    next();
  });
}

/**
 * F3 (Wave-4 review, LOW): Express's default `X-Powered-By: Express`
 * response header discloses server technology for free reconnaissance
 * value with zero upside to an operator. Express exposes this as a
 * setting, not a header to strip after the fact.
 */
export function disableXPoweredBy(app: INestApplication): void {
  (app.getHttpAdapter().getInstance() as Express).disable("x-powered-by");
}

/**
 * P4.17 / STATE.md P4.7 (lane G1): kills the ephemeral-JWT-secret footgun
 * (token.service.ts's own header: "every access token this process signs
 * is invalidated on restart" when no LOOMBRE_JWT_SECRET is set) for
 * zero-config installs. Resolution order — env always wins, never
 * overwritten — is entirely @loombre/secrets's (see that package's
 * jwt-secret.ts): LOOMBRE_JWT_SECRET env -> the platform's auto-detected
 * secrets store -> generate-and-persist there on first boot. Setting
 * process.env["LOOMBRE_JWT_SECRET"] here, BEFORE NestFactory.create(),
 * means TokenService's existing constructor logic (env-or-ephemeral) picks
 * up a value that is now durable — that class itself needed ZERO changes.
 * Never throws: a secrets-store failure (locked keychain, no D-Bus
 * session, unwritable disk) falls back to the SAME ephemeral in-process
 * random secret behavior this had before this function existed, logged
 * loudly rather than crashing boot over a convenience feature.
 */
export async function resolveAndSeedJwtSecret(env: NodeJS.ProcessEnv): Promise<void> {
  if (env["LOOMBRE_JWT_SECRET"]?.trim()) return; // env already wins; nothing to do.
  try {
    const { dataDir } = resolveAppPaths(process.platform, env);
    const key = join(dataDir, "secrets", "jwt-signing-secret");
    const result = await resolveJwtSecret({ key, env });
    process.env["LOOMBRE_JWT_SECRET"] = result.secret;
    console.log(`@loombre/server: JWT signing secret resolved (source: ${result.source}${result.backend ? `, backend: ${result.backend}` : ""}).`);
  } catch (err) {
    console.warn(
      `@loombre/server: JWT secret store resolution failed (${String(err)}) — falling back to token.service.ts's ` +
        "own ephemeral per-process secret (P1.9 zero-config boot posture; every restart will invalidate outstanding access tokens until this is fixed).",
    );
  }
}

export interface BootstrapResult {
  app: INestApplication;
  /** Closes whichever server actually ended up listening (plain app.close()
   *  for tlsConfig.mode === "off"; the TLS runtime's own close() PLUS
   *  app.close() otherwise — see tls/runtime.ts's TlsRuntime.close()) and
   *  the IPC listener if one was started. Idempotent is NOT guaranteed —
   *  callers (installGracefulShutdown) call this exactly once. */
  closeServer: () => Promise<void>;
}

export interface TlsListenResult {
  /** The port the https.Server actually bound — equals tlsConfig.httpsPort
   *  in production; reading it off server.address() is what lets TLS-mode
   *  integration tests pass httpsPort 0 for an ephemeral bind. */
  boundPort: number;
  /** tlsRuntime.close() only — stops renewal/watchers and the listening
   *  https.Server. The caller still owns app.close() (see bootstrap()'s
   *  closeListenServer comment for why both halves are load-bearing). */
  close: () => Promise<void>;
}

/**
 * The manual/acme half of bootstrap()'s listen branch, extracted
 * (applyTrustProxy's own precedent above) so TLS-mode integration tests
 * can drive the EXACT sequence the real entrypoint runs — app.init(), TLS
 * runtime creation, WS upgrade-handler attachment, listen — without
 * invoking bootstrap() itself (which also provisions a database and seeds
 * a JWT secret). `acmeTestDeps` forwards tls/runtime.ts's test-only pebble
 * knobs; production callers pass nothing.
 */
export async function listenWithTls(
  app: INestApplication,
  tlsConfig: Exclude<TlsConfig, { mode: "off" }>,
  opts: CreateTlsRuntimeOptions = {},
): Promise<TlsListenResult> {
  await app.init();
  const tlsRuntime = await createTlsRuntime(tlsConfig, app.getHttpAdapter().getInstance(), opts);
  const httpsServer = tlsRuntime.server;
  if (httpsServer === null) throw new Error("unreachable: tlsConfig.mode !== 'off' but createTlsRuntime returned server=null");
  // The https.Server is a DIFFERENT server object from the http.Server
  // Nest created during init() — the /v1/events WS upgrade handler
  // (gateway/ws-broadcaster.service.ts) must be attached to it explicitly
  // or every WS handshake on the TLS path falls through to the REST stack
  // (common/ws-upgrade.registry.ts's header has the full story).
  app.get(WsUpgradeRegistry).attach(httpsServer);
  await new Promise<void>((resolve, reject) => {
    httpsServer.once("error", reject);
    httpsServer.listen(tlsConfig.httpsPort, () => resolve());
  });
  const address = httpsServer.address();
  const boundPort = address !== null && typeof address === "object" ? address.port : tlsConfig.httpsPort;
  return {
    boundPort,
    close: async () => {
      await tlsRuntime.close();
    },
  };
}

async function bootstrap(): Promise<BootstrapResult> {
  // STATE.md P4.2 (lane B): resolves external-vs-embedded PostgreSQL and
  // exports the working DATABASE_URL into process.env BEFORE anything
  // below constructs a pool against it — see
  // apps/server/src/bootstrap/provisioning.ts for the full seam.
  const { databaseUrl } = await bootstrapProvisioning();
  process.env["DATABASE_URL"] ??= databaseUrl;

  // Lane G1 (P4.7/P4.17): resolved BEFORE NestFactory.create() so
  // TokenService's constructor (which runs during DI container
  // construction) reads a durable value on the very first boot, not just
  // every boot after the first.
  await resolveAndSeedJwtSecret(process.env);

  const app = await NestFactory.create(AppModule, {
    logger: ["log", "warn", "error"],
  });

  // RG12 (STATE.md "Loombre Remote..."): tls.mode/tls.acmeDomains/
  // tls.acmeChallengeType/tls.acmeTosAgreed/network.trustProxy are now
  // ui-scope (settings-registry.ts) — hydrate process.env from whatever
  // SettingsService resolves BEFORE the raw-env readers below run, so a
  // DB-only-committed Direct-path config (apps/server/src/remote/
  // remote-direct.controller.ts's enableRemoteDirect) actually takes
  // effect on the next restart instead of only ever living in the
  // database (see settings-boot-bridge.ts's header for the full story).
  // Best-effort and NEVER fatal: bootstrapProvisioning() above already
  // makes the database a hard boot precondition in practice, but TLS/
  // trust-proxy selection itself was NEVER DB-dependent before this call
  // existed, so a hiccup here falls back to exactly that prior behavior
  // (raw env only) rather than turning a one-time convenience read into a
  // new way to fail boot — same posture as resolveAndSeedJwtSecret above.
  try {
    const settingsService = app.get(SettingsService);
    await settingsService.bootstrap();
    hydrateTlsEnvFromSettings(settingsService, process.env);
  } catch (err) {
    console.warn(
      `@loombre/server: settings-boot-bridge failed (${String(err)}) — TLS mode and trust-proxy resolve from ` +
        "environment variables only for this boot, same as before RG12's settings promotion.",
    );
  }

  applyTrustProxy(app, process.env["LOOMBRE_TRUST_PROXY"]);
  applyCors(app, process.env["LOOMBRE_CORS_ORIGINS"]);
  applySecurityHeaders(app);
  disableXPoweredBy(app);

  // P4.4: LOOMBRE_TLS_MODE=off (default) takes the exact pre-existing
  // app.listen(PORT) path below, byte-identical to before this module
  // existed. manual/acme instead hand the Express request listener to
  // apps/server/src/tls/runtime.ts, which returns a live https.Server.
  const tlsConfig = loadTlsConfig(process.env);
  applyHsts(app, {
    tlsInternal: tlsConfig.mode !== "off",
    trustProxyEnabled: resolveTrustProxySetting(process.env["LOOMBRE_TRUST_PROXY"]) !== undefined,
  });

  // boundPort is whichever port ends up actually serving requests below —
  // set once by exactly one of the two branches, then read by the single
  // wireServerIpc() call at the bottom so the IPC listener (deliverable 2:
  // "starts with the server, after listen") starts after EITHER path, not
  // just the (default) tlsConfig.mode === "off" one.
  let boundPort: number;
  // Populated by whichever branch below actually starts a server — the
  // lane G1 graceful-shutdown path (installGracefulShutdown, at the bottom
  // of this file) needs to close the SAME thing that got opened, and the
  // TLS branch's httpsServer is a distinct object from anything app.close()
  // alone would tear down (see tls/runtime.ts's own module header).
  let closeListenServer: () => Promise<void>;

  if (tlsConfig.mode === "off") {
    boundPort = Number(process.env["PORT"] ?? 3001);
    await app.listen(boundPort);
    console.log(`@loombre/server listening on port ${boundPort}`);
    closeListenServer = async () => {
      await app.close();
    };
  } else {
    const tlsListen = await listenWithTls(app, tlsConfig);
    boundPort = tlsListen.boundPort;
    console.log(`@loombre/server listening on port ${boundPort} (TLS mode: ${tlsConfig.mode})`);
    closeListenServer = async () => {
      // tlsListen.close() stops cert renewal/watchers and closes the
      // ACTUAL listening https.Server; app.close() additionally triggers
      // Nest's OnModuleDestroy lifecycle (DbProvider.db.destroy() —
      // "end the pool", task spec) on a Nest instance that itself never
      // called .listen() in this branch, so it's a fast, harmless no-op
      // for the HTTP-serving side but load-bearing for the DB pool.
      await tlsListen.close();
      await app.close();
    };
  }

  // Phase 4 Wave 2 IPC-listener lane: loopback-only control surface for the
  // platform controller apps (Windows tray, macOS menubar) — see
  // apps/server/src/ipc/index.ts for the kill-switch + full wiring; no-ops
  // (logs why) unless LOOMBRE_DATA_DIR is set.
  const ipcHandle = await wireServerIpc(app, { serverPort: boundPort, serverTlsMode: tlsConfig.mode });

  return {
    app,
    closeServer: async () => {
      if (ipcHandle) await ipcHandle.stop();
      await closeListenServer();
    },
  };
}

// Only run the real entrypoint when this file is executed directly (`node
// dist/main.js` / `tsx src/main.ts`) — NOT when imported as a module (e.g.
// this file's own unit test importing `resolveTrustProxySetting`), which
// must never have the side effect of booting a real server + DB
// connection just from being imported.
//
// argv[1] must be realpath'd before comparing: Node resolves
// import.meta.url through symlinks but leaves argv[1] as typed, so a
// launch through ANY symlinked path component (e.g. the macOS pkg's
// /opt/loombre/current upgrade symlink, or a systemd ExecStart via a
// versioned link) made this guard silently false — server exits 0 having
// done nothing (Phase 4 lane I4 finding; installer bin wrappers shim with
// pwd -P, this is the root fix). realpathSync throws on a nonexistent
// path, so fall back to the raw value rather than crashing importers.
function resolveArgvHref(argv1: string): string {
  let resolved = argv1;
  try {
    resolved = realpathSync(argv1);
  } catch {
    /* keep as-typed; comparison below simply stays false */
  }
  return pathToFileURL(resolved).href;
}
const isDirectEntrypoint =
  process.argv[1] !== undefined && import.meta.url === resolveArgvHref(process.argv[1]);

if (isDirectEntrypoint) {
  // Lane G1 (STATE.md P4.14): installed FIRST, before bootstrap() runs at
  // all, so a crash during provisioning/DI-container construction itself
  // still produces a redacted crash file — not just crashes after the
  // server is already listening. dataDir is resolved synchronously (pure,
  // no I/O — see cli/app-paths.ts) so this needs no await before the
  // handlers are live.
  const { dataDir } = resolveAppPaths(process.platform, process.env);
  installCrashHandlers({ dataDir, version: LOOMBRE_VERSION_FULL });

  bootstrap()
    .then(({ app, closeServer }) => {
      // Admin power endpoints (POST /system/restart|shutdown): a restart
      // is "graceful shutdown, but exit with the named restart code so
      // the supervisor relaunches" — launchd SuccessfulExit=false /
      // systemd on-failure / the Windows service host's non-zero-child
      // mapping / Docker unless-stopped all restart a non-zero exit.
      // Success-path only: a FAILED graceful shutdown keeps its exit 1
      // (also relaunched — a restart request that tears down badly should
      // still come back).
      let gracefulExitCode = 0;
      // The other half of P4.14 + the Windows I3 SIGBREAK gap this lane
      // closes: apps/server had ZERO signal handlers before this (STATE.md
      // P4.14's own audit finding) — every stop, on every platform,
      // silently fell through to whatever OS-default SIGTERM handling is
      // (immediate, non-graceful termination) or, on Windows via the
      // service host, the timeout-then-kill fallback
      // (installers/windows/service-host's own header names this exact gap).
      // T2/RG7: the connector's own supervised child (cloudflared, when the
      // Tunnel path is enabled) needs the SAME graceful-stop treatment the
      // embedded-PG child gets below — captured here, before closeServer()
      // tears down the Nest container, exactly like `ServerPowerService`
      // is grabbed via `app.get()` further down; CloudflaredConnectorManager.
      // stop() is safe to call unconditionally (a no-op when nothing was
      // ever started — mirrors ConnectorManager.stop()'s own idempotent
      // contract, connector-manager.ts's abstract method doc comment).
      const connectorManager = app.get(ConnectorManager);
      installGracefulShutdown({
        onShutdown: async (_signal: ShutdownSignal) => {
          await closeServer();
          // Best-effort graceful stop of the embedded-PG child process
          // (bootstrap/provisioning.ts's own header: its process.once("exit",
          // killSync) safety net is "NOT a substitute for a real graceful
          // SIGTERM handler ... a separate deliverable this lane does not
          // own" — this IS that deliverable). Skipped entirely if
          // bootstrapProvisioning() never ran. External-PG mode owns NO
          // child process to stop and its stop() deliberately THROWS
          // ExternalModeInertError (packages/provisioning-pg/src/external.ts:
          // "every mutating call is inert + throws") — calling it
          // unconditionally made a normal external-PG SIGTERM exit 1 as a
          // "graceful shutdown failed" (struct-lane finding). Guard on the
          // controller's own status so only an embedded controller is stopped.
          const provisioning = getProvisioningController();
          if (provisioning && provisioning.getCurrentProvisioningStatus().state !== "external") {
            await provisioning.stop("fast");
          }
          // T2/RG7: SIGTERM the connector child (grace timeout -> SIGKILL,
          // same escalation ladder as the embedded-PG stop above) so a
          // server restart/shutdown never leaves an orphaned cloudflared
          // process behind.
          await connectorManager.stop();
        },
        exit: (code) => process.exit(code === 0 ? gracefulExitCode : code),
      });

      // Arm the admin power endpoints' real triggers — ONLY here, in the
      // direct entrypoint, mirroring installGracefulShutdown itself:
      // embedded contexts (conformance/e2e suites boot AppModule and walk
      // POST /system/restart with a live admin token) must get the
      // service's logged no-op, never a SIGTERM into the test runner.
      // Both triggers ride the existing graceful path (SIGTERM → the
      // onShutdown above); restart differs ONLY in the success exit code.
      app.get(ServerPowerService).arm({
        shutdown: () => process.kill(process.pid, "SIGTERM"),
        restart: () => {
          gracefulExitCode = RESTART_REQUESTED_EXIT_CODE;
          process.kill(process.pid, "SIGTERM");
        },
      });
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
