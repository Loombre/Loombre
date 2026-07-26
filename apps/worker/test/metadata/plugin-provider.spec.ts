// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/plugin-provider.spec.ts
//
// Unit tests for createLppMetadataProvider (LPP v1, Lane W3, mission
// point 1) against an in-test stub LPP plugin HTTP server (ephemeral
// port, node:http — same pattern as packages/plugin-host/test/
// call-plugin.spec.ts's hung-server case; examples/lpp-reference-provider
// is the live-plugin counterparty these fixtures are modeled on).
//
// Covers: name is the STABLE `lpp:<pluginId>` identifier (never the
// manifest's own `name`); contentClass/kinds/enabled reflect the plugin
// row per the mission's explicit field mapping; C5 STRICT construction
// refusal (layer 3 of the three-layer defense — see plugin-provider.ts's
// header); a plugin not GRANTED metadata-provider, or with a malformed
// manifest capability entry, refuses to construct; search/details/images
// round-trip through the FROZEN wire schemas both directions; a
// schema-invalid plugin response is a typed LppProviderCallError, never a
// crash; secret configSchema fields are resolved from the keyring at CALL
// time and injected as X-LPP-Secret-<NAME> headers.
//
// `db` is passed as an unused stub in every test here EXCEPT the breaker-
// trip case (which needs a live DB — covered by
// chain-resolution.spec.ts's breaker-trip integration test instead, to
// keep this file DB-free and fast).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { storeSecret } from '@loombre/secrets';
import { PluginCircuitBreaker } from '@loombre/plugin-host';
import { createLppMetadataProvider, lppProviderName, LppProviderCallError, type LppProviderPluginInput } from '../../src/metadata/plugin-provider.js';
import type { DbOrTx } from '@loombre/db/internal';

const UNUSED_DB = {} as unknown as DbOrTx;

function fixtureManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'fixture-plugin',
    version: '0.1.0',
    protocolVersion: 1,
    capabilities: [
      {
        type: 'metadata-provider',
        mediaKinds: ['movie', 'tv'],
        contentClass: 'general',
        endpoints: { search: '/lpp/provider/search', details: '/lpp/provider/details', images: '/lpp/provider/images' },
        ...((overrides.capabilityOverrides as Record<string, unknown>) ?? {}),
      },
    ],
    configSchema: (overrides.configSchema as Record<string, unknown>) ?? { type: 'object', properties: {}, additionalProperties: false },
    description: 'fixture',
    publisher: 'Loombre',
  };
}

function fixturePlugin(overrides: Partial<LppProviderPluginInput> & { baseUrl: string }): LppProviderPluginInput {
  return {
    id: 'fixture-plugin-id',
    enabled: true,
    contentClass: 'general',
    lanAllowlist: ['127.0.0.1'],
    grantedCapabilityTypes: ['metadata-provider'],
    manifest: fixtureManifest(),
    config: {},
    ...overrides,
  };
}

type RouteHandler = (body: unknown) => { status: number; body: unknown };

function startStubServer(routes: Record<string, RouteHandler>): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const key = `${req.method} ${req.url}`;
      const handler = routes[key];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no route' }));
        return;
      }
      let parsedBody: unknown = {};
      try {
        parsedBody = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        // fall through with {}
      }
      const { status, body } = handler(parsedBody);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('createLppMetadataProvider — construction (no network)', () => {
  it('the returned provider has the STABLE name lpp:<pluginId>, never the manifest name', () => {
    const provider = createLppMetadataProvider(fixturePlugin({ id: 'abc-123', baseUrl: 'http://127.0.0.1:1' }), {
      db: UNUSED_DB,
      breaker: new PluginCircuitBreaker(),
      targetContentClass: 'general',
    });
    expect(provider?.name).toBe('lpp:abc-123');
    expect(provider?.name).toBe(lppProviderName('abc-123'));
  });

  it('contentClass/kinds/enabled mirror the metadata-provider CAPABILITY (H-2 fix wave) and the plugin row', () => {
    const provider = createLppMetadataProvider(
      fixturePlugin({
        baseUrl: 'http://127.0.0.1:1',
        contentClass: 'restricted',
        enabled: true,
        manifest: fixtureManifest({ capabilityOverrides: { contentClass: 'restricted' } }),
      }),
      {
        db: UNUSED_DB,
        breaker: new PluginCircuitBreaker(),
        targetContentClass: 'restricted',
      },
    );
    expect(provider?.contentClass).toBe('restricted');
    expect(provider?.kinds).toEqual(['movie', 'tv']);
    expect(provider?.enabled).toBe(true);
    expect(provider?.disabledReason).toBeUndefined();
  });

  // H-2 fix wave regression: the exact mixed-class shape the adversarial
  // review found — the plugin's AGGREGATE content_class is 'restricted'
  // (because some OTHER, sibling capability on this same plugin is
  // restricted-scoped), but the metadata-provider CAPABILITY ITSELF is
  // declared 'general'. Before this fix, construction read
  // `plugin.contentClass` (the aggregate) and would have refused a
  // 'general' target here (aggregate='restricted' !== target='general') —
  // the WRONG direction of failure for THIS capability, and in the
  // opposite direction (a 'restricted' target) would have WRONGLY
  // constructed a general-scoped adapter for a restricted library. The fix
  // reads the capability's OWN contentClass, so construction now tracks
  // the capability, never the sibling-widened aggregate.
  it('H-2: a mixed-class plugin (aggregate=restricted, capability=general) constructs for a GENERAL target, refuses for a RESTRICTED one', () => {
    const mixedPlugin = fixturePlugin({
      baseUrl: 'http://127.0.0.1:1',
      contentClass: 'restricted', // AGGREGATE — widened by a sibling capability
      manifest: fixtureManifest({ capabilityOverrides: { contentClass: 'general' } }), // the metadata-provider capability's OWN class
    });

    const generalProvider = createLppMetadataProvider(mixedPlugin, {
      db: UNUSED_DB,
      breaker: new PluginCircuitBreaker(),
      targetContentClass: 'general',
    });
    expect(generalProvider).not.toBeNull();
    expect(generalProvider?.contentClass).toBe('general');

    const restrictedProvider = createLppMetadataProvider(mixedPlugin, {
      db: UNUSED_DB,
      breaker: new PluginCircuitBreaker(),
      targetContentClass: 'restricted',
      log: () => {},
    });
    expect(restrictedProvider).toBeNull();
  });

  it('enabled:false surfaces a disabledReason (mirrors the built-in providers’ P1.9 pattern)', () => {
    const provider = createLppMetadataProvider(fixturePlugin({ baseUrl: 'http://127.0.0.1:1', enabled: false }), {
      db: UNUSED_DB,
      breaker: new PluginCircuitBreaker(),
      targetContentClass: 'general',
    });
    expect(provider?.enabled).toBe(false);
    expect(provider?.disabledReason).toBeTruthy();
  });

  it('C5 STRICT (layer 3, H-2 fix wave): refuses to construct when the CAPABILITY contentClass !== targetContentClass, general capability vs restricted target', () => {
    const provider = createLppMetadataProvider(fixturePlugin({ baseUrl: 'http://127.0.0.1:1', contentClass: 'general' }), {
      db: UNUSED_DB,
      breaker: new PluginCircuitBreaker(),
      targetContentClass: 'restricted',
      log: () => {},
    });
    expect(provider).toBeNull();
  });

  it('C5 STRICT (layer 3, H-2 fix wave): refuses to construct when the CAPABILITY contentClass !== targetContentClass, restricted capability vs general target', () => {
    const provider = createLppMetadataProvider(
      fixturePlugin({
        baseUrl: 'http://127.0.0.1:1',
        contentClass: 'restricted',
        manifest: fixtureManifest({ capabilityOverrides: { contentClass: 'restricted' } }),
      }),
      {
        db: UNUSED_DB,
        breaker: new PluginCircuitBreaker(),
        targetContentClass: 'general',
        log: () => {},
      },
    );
    expect(provider).toBeNull();
  });

  it('refuses to construct when the plugin has no GRANTED metadata-provider capability', () => {
    const provider = createLppMetadataProvider(fixturePlugin({ baseUrl: 'http://127.0.0.1:1', grantedCapabilityTypes: ['event-subscriber'] }), {
      db: UNUSED_DB,
      breaker: new PluginCircuitBreaker(),
      targetContentClass: 'general',
      log: () => {},
    });
    expect(provider).toBeNull();
  });

  it('refuses to construct when the manifest has no valid metadata-provider capability entry', () => {
    const provider = createLppMetadataProvider(
      fixturePlugin({ baseUrl: 'http://127.0.0.1:1', manifest: { name: 'x', version: '1', protocolVersion: 1, capabilities: [], configSchema: {}, description: 'x', publisher: 'x' } }),
      { db: UNUSED_DB, breaker: new PluginCircuitBreaker(), targetContentClass: 'general', log: () => {} }
    );
    expect(provider).toBeNull();
  });
});

describe('createLppMetadataProvider — live calls against a stub LPP server', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))));
  });

  it('search(): encodes the request per LppSearchRequestSchema and decodes a valid response', async () => {
    let seenBody: unknown;
    const { server, baseUrl } = await startStubServer({
      'POST /lpp/provider/search': (body) => {
        seenBody = body;
        return {
          status: 200,
          body: { results: [{ ref: { provider: 'lpp-fixture', externalId: '42', mediaKind: 'movie' }, title: 'A Fixture Movie', year: 2020, overview: 'desc', popularity: 3.2 }] },
        };
      },
    });
    servers.push(server);

    const provider = createLppMetadataProvider(fixturePlugin({ baseUrl }), { db: UNUSED_DB, breaker: new PluginCircuitBreaker(), targetContentClass: 'general' });
    expect(provider).not.toBeNull();

    const results = await provider!.search({ mediaKind: 'movie', title: 'A Fixture Movie', year: 2020 });

    expect(seenBody).toEqual({ mediaKind: 'movie', title: 'A Fixture Movie', year: 2020 });
    expect(results).toEqual([
      {
        ref: { provider: 'lpp-fixture', externalId: '42', mediaKind: 'movie', seasonNumber: null, episodeNumber: null },
        title: 'A Fixture Movie',
        year: 2020,
        overview: 'desc',
        popularity: 3.2,
      },
    ]);
  });

  it('fetchDetails(): decodes a movie details response into the internal ProviderDetails shape', async () => {
    const { server, baseUrl } = await startStubServer({
      'POST /lpp/provider/details': () => ({
        status: 200,
        body: {
          details: {
            itemType: 'movie',
            title: 'A Fixture Movie',
            sortTitle: 'Fixture Movie, A',
            year: 2020,
            overview: 'desc',
            communityRating: 7.5,
            contentRating: 'PG-13',
            genres: ['Drama'],
            tags: ['fixture'],
            people: [{ name: 'Fixture Actor', role: 'actor', order: 0, credit: 'Self' }],
            providerIds: { 'lpp-fixture': '42' },
            tagline: 'a tagline',
            runtimeMs: 6_000_000,
          },
        },
      }),
    });
    servers.push(server);

    const provider = createLppMetadataProvider(fixturePlugin({ baseUrl }), { db: UNUSED_DB, breaker: new PluginCircuitBreaker(), targetContentClass: 'general' });
    const details = await provider!.fetchDetails({ provider: 'lpp-fixture', externalId: '42', mediaKind: 'movie' });

    expect(details).toEqual({
      itemType: 'movie',
      title: 'A Fixture Movie',
      sortTitle: 'Fixture Movie, A',
      year: 2020,
      overview: 'desc',
      communityRating: 7.5,
      contentRating: 'PG-13',
      genres: ['Drama'],
      tags: ['fixture'],
      people: [{ name: 'Fixture Actor', role: 'actor', order: 0, credit: 'Self' }],
      providerIds: { 'lpp-fixture': '42' },
      tagline: 'a tagline',
      runtimeMs: 6_000_000,
    });
  });

  it('fetchDetails(): decodes a track details response (a non-movie itemType branch)', async () => {
    const { server, baseUrl } = await startStubServer({
      'POST /lpp/provider/details': () => ({
        status: 200,
        body: {
          details: {
            itemType: 'track',
            title: 'A Fixture Track',
            sortTitle: 'Fixture Track, A',
            year: null,
            overview: null,
            communityRating: null,
            contentRating: null,
            genres: [],
            tags: [],
            people: [],
            providerIds: {},
            trackNumber: 3,
            discNumber: 1,
            durationMs: 210_000,
          },
        },
      }),
    });
    servers.push(server);

    const provider = createLppMetadataProvider(fixturePlugin({ baseUrl }), { db: UNUSED_DB, breaker: new PluginCircuitBreaker(), targetContentClass: 'general' });
    const details = await provider!.fetchDetails({ provider: 'lpp-fixture', externalId: '99', mediaKind: 'music', entityKind: 'track' });

    expect(details).toMatchObject({ itemType: 'track', trackNumber: 3, discNumber: 1, durationMs: 210_000 });
  });

  it('fetchImages(): decodes a valid images response', async () => {
    const { server, baseUrl } = await startStubServer({
      'POST /lpp/provider/images': () => ({
        status: 200,
        body: { images: [{ kind: 'poster', url: 'https://example.invalid/poster.jpg', width: 1000, height: 1500 }] },
      }),
    });
    servers.push(server);

    const provider = createLppMetadataProvider(fixturePlugin({ baseUrl }), { db: UNUSED_DB, breaker: new PluginCircuitBreaker(), targetContentClass: 'general' });
    const images = await provider!.fetchImages({ provider: 'lpp-fixture', externalId: '42', mediaKind: 'movie' });

    expect(images).toEqual([{ kind: 'poster', url: 'https://example.invalid/poster.jpg', width: 1000, height: 1500 }]);
  });

  it('a schema-invalid search response is a typed LppProviderCallError, never a crash', async () => {
    const { server, baseUrl } = await startStubServer({
      'POST /lpp/provider/search': () => ({ status: 200, body: { results: [{ ref: { provider: 'x' /* missing externalId/mediaKind */ }, title: 'x' }] } }),
    });
    servers.push(server);

    const provider = createLppMetadataProvider(fixturePlugin({ baseUrl }), { db: UNUSED_DB, breaker: new PluginCircuitBreaker(), targetContentClass: 'general' });
    await expect(provider!.search({ mediaKind: 'movie', title: 'x' })).rejects.toThrow(LppProviderCallError);
  });

  it('a non-2xx status is a typed LppProviderCallError', async () => {
    const { server, baseUrl } = await startStubServer({
      'POST /lpp/provider/search': () => ({ status: 422, body: { type: 'urn:loombre:lpp:problem:validation', title: 'Unprocessable Entity', status: 422, detail: 'bad' } }),
    });
    servers.push(server);

    const provider = createLppMetadataProvider(fixturePlugin({ baseUrl }), { db: UNUSED_DB, breaker: new PluginCircuitBreaker(), targetContentClass: 'general' });
    await expect(provider!.search({ mediaKind: 'movie', title: 'x' })).rejects.toThrow(LppProviderCallError);
  });

  it('sends the plugin’s non-secret config via X-LPP-Config', async () => {
    let seenConfigHeader: string | undefined;
    const { server, baseUrl } = await startStubServer({
      'POST /lpp/provider/search': (_body) => {
        return { status: 200, body: { results: [] } };
      },
    });
    server.on('request', (req) => {
      seenConfigHeader = req.headers['x-lpp-config'] as string | undefined;
    });
    servers.push(server);

    const provider = createLppMetadataProvider(fixturePlugin({ baseUrl, config: { fixturePrefix: 'hello' } }), {
      db: UNUSED_DB,
      breaker: new PluginCircuitBreaker(),
      targetContentClass: 'general',
    });
    await provider!.search({ mediaKind: 'movie', title: 'x' });

    expect(seenConfigHeader).toBeDefined();
    const decoded: unknown = JSON.parse(Buffer.from(seenConfigHeader!, 'base64').toString('utf8'));
    expect(decoded).toEqual({ fixturePrefix: 'hello' });
  });
});

describe('createLppMetadataProvider — secret configSchema fields resolved from the keyring at call time', () => {
  let dataDir: string;
  let previousBackend: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'loombre-lpp-secret-test-'));
    previousBackend = process.env.LOOMBRE_SECRET_BACKEND;
    // Force the universal file0600 backend for deterministic, CI-safe
    // tests — mirrors keys.ts's own posture that keyring reads must
    // never depend on a real OS credential store being available.
    process.env.LOOMBRE_SECRET_BACKEND = 'file0600';
  });

  afterEach(() => {
    if (previousBackend === undefined) delete process.env.LOOMBRE_SECRET_BACKEND;
    else process.env.LOOMBRE_SECRET_BACKEND = previousBackend;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('injects X-LPP-Secret-<NAME> for a configSchema field marked secret:true, resolved via plugin-<id>-<field>', async () => {
    const pluginId = 'secret-fixture-plugin';
    await storeSecret('file0600', `${dataDir}/secrets/plugin-${pluginId}-apiKey`, 's3cr3t-value');

    let seenSecretHeader: string | undefined;
    const server = createServer((req, res) => {
      seenSecretHeader = req.headers['x-lpp-secret-APIKEY'.toLowerCase()] as string | undefined;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results: [] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const provider = createLppMetadataProvider(
        fixturePlugin({
          id: pluginId,
          baseUrl: `http://127.0.0.1:${port}`,
          manifest: fixtureManifest({
            configSchema: {
              type: 'object',
              properties: { apiKey: { type: 'string', secret: true } },
              additionalProperties: false,
            },
          }),
        }),
        { db: UNUSED_DB, breaker: new PluginCircuitBreaker(), targetContentClass: 'general', env: { LOOMBRE_DATA_DIR: dataDir } as NodeJS.ProcessEnv }
      );
      await provider!.search({ mediaKind: 'movie', title: 'x' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(seenSecretHeader).toBeDefined();
    expect(Buffer.from(seenSecretHeader!, 'base64').toString('utf8')).toBe('s3cr3t-value');
  });
});
