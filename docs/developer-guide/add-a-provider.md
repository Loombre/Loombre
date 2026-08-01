# Adding a metadata provider

<!-- Sourcing: apps/worker/src/metadata/provider.ts (MetadataProvider
     interface), registry.ts (ProviderRegistry, assertScope), consumer.ts
     (metadataConsumerHandler, pickBestMatch),
     provider-chain-defaults.ts (PROVIDER_CHAIN, the default fallback
     chain) + chain-resolution.ts (per-library chain override resolved at
     job time), precedence.ts
     (mergeFields, nfo > tags > provider > filename precedence,
     metadata_lock), keys.ts (resolveApiKey — the env-var side — plus
     resolveApiKeyWithKeyring, which falls back to the OS keyring via
     @loombre/secrets when the env var is unset), apps/server/src/settings/
     provider-keys.service.ts (Addendum A: the admin-settings-screen ->
     OS-keyring seam, env-still-wins precedence — keys.ts's
     resolveApiKeyWithKeyring is the worker-side consumer of that seam,
     called at boot from index.ts),
     apps/worker/src/index.ts:151-169 (manual registration, no DI framework),
     apps/worker/src/metadata/providers/{tmdb,tvdb,musicbrainz}.ts (the
     three built-in providers), apps/worker/test/metadata/** (tests to
     mirror), apps/worker/src/metadata/test-support.ts (makeFakeProvider).
     docs/PLAN.md §4.4 (extension points) and §8.3 (metadata & images
     precedence/provenance model). -->

Loombre looks up metadata (titles, descriptions, cast, artwork) from
external sources during scanning, through a small provider interface. This
page is the concrete steps to add a new one, grounded in the three
providers that already exist: TMDB and TVDB (movies/TV) and MusicBrainz
(music).

## The interface

Every provider lives in `apps/worker/src/metadata/providers/` and
implements the `MetadataProvider` interface
(`apps/worker/src/metadata/provider.ts`):

```ts
interface MetadataProvider {
  readonly name: string;
  readonly contentClass: ContentClass;   // 'general' | 'restricted'
  readonly kinds: readonly MediaKind[];  // 'movie' | 'tv' | 'music'
  readonly enabled: boolean;
  readonly disabledReason?: string;
  search(query: SearchQuery): Promise<ProviderSearchResult[]>;
  fetchDetails(ref: ProviderRef): Promise<ProviderDetails>;
  fetchImages(ref: ProviderRef): Promise<ProviderImageRef[]>;
}
```

`ProviderDetails` is a closed union keyed by `itemType` (movie, series,
season, episode, artist, album, track) — see `provider.ts` for the full
shape per type.

Note what's **not** a `MetadataProvider`: local NFO/sidecar file reading
(`apps/worker/src/metadata/nfo.ts`) is a separate precedence input, not a
provider — it only ever runs inside the scanner's own import path
(CLAUDE.md invariant 8), never as something a provider triggers.

## Where results go

`apps/worker/src/metadata/consumer.ts` drives the merge: for each media
kind, it walks a fallback chain of provider names (`PROVIDER_CHAIN` — for
example, TV tries TMDB first, then TVDB), picks the best match via
`match.ts`, then merges fields through `precedence.ts`'s `mergeFields` with
a fixed precedence order: **local NFO/tags first, then provider data, then
filename inference last** — honoring a per-field `metadata_lock` so a
field an admin has manually edited or locked is never silently overwritten
by a later scan. The whole merge, plus the resulting `metadata_provenance`
and `provider_ids` rows, writes in one transaction.

## Adding a new provider — the steps

1. **Create the provider file**: `apps/worker/src/metadata/providers/your-provider.ts`,
   exporting a factory (`createYourProvider({ db })`, matching the existing
   providers' shape) that returns a `MetadataProvider`.
2. **API key handling**: if your provider needs one, add it to
   `apps/worker/src/metadata/keys.ts`'s `resolveApiKey()`. There are two
   seams for a key today: an environment variable (e.g.
   `LOOMBRE_TMDB_API_KEY`, documented in `installers/docker/loombre.env.example`)
   wins when it's set; otherwise an admin can enter one from the admin
   settings screen, which stores it in the OS keyring rather than
   `server_settings` (a provider key is a secret, not configuration). The
   worker resolves both seams at boot via `resolveApiKeyWithKeyring()`
   (same file) — env var first, keyring second — so a key entered only via
   the admin settings screen is picked up from the next worker restart.
   Either way, a missing/unresolved key must not crash
   anything: construct the provider with `enabled: false` and a
   `disabledReason` instead (the existing providers all do this).
3. **Register it**: add one line to `apps/worker/src/index.ts`, alongside
   the existing registrations:
   ```ts
   registry.register(createYourProvider({ db }));
   ```
   There's no dependency-injection framework here — `ProviderRegistry`
   (`apps/worker/src/metadata/registry.ts`) is a plain map with a mandatory
   `assertScope()` choke-point that enforces a restricted-scoped provider
   can never be registered against a general-content library.
4. **Add it to the fallback chain**: if it should participate in the
   automatic lookup for a given media kind, add its name to the relevant
   entry in `PROVIDER_CHAIN` (`provider-chain-defaults.ts`). Note that
   this constant is only the *default*: since LPP v1, the chain actually
   used for a job is resolved per library at job time
   (`chain-resolution.ts`, backed by the `library_provider_entries` table
   and editable via `PUT /admin/libraries/{id}/provider-chain`), so a
   library with a customized chain won't pick up your provider until it's
   added to that library's chain too.
5. **Write tests mirroring the existing providers**:
   - `apps/worker/test/metadata/providers/your-provider.spec.ts` — unit
     tests against fixture data (see the fixture layout under
     `apps/worker/test/metadata/fixtures/<provider>/*.json`).
   - A `*.live.spec.ts` counterpart, network-gated behind an env var (the
     existing providers use `LOOMBRE_LIVE_PROVIDER_TESTS=1` plus a real
     key), if you want a real-network smoke test that doesn't run by
     default.
   - For tests elsewhere that just need *a* provider without caring which
     one, use `apps/worker/src/metadata/test-support.ts`'s
     `makeFakeProvider()` rather than instantiating a real one.

## Restricted-content providers

If your provider is for restricted-content libraries specifically (an
adult-content metadata source, for example), set `contentClass:
'restricted'` — `registry.assertScope()` then refuses to let the scanner
run it against a general library, at the registration/dispatch layer, not
by convention.
