// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/registry.spec.ts
//
// Proves the scoping choke-point (P1.6): restricted provider + general
// library throws; general provider + restricted library is allowed.

import { describe, expect, it } from 'vitest';
import { ProviderRegistry, RestrictedProviderScopeError, UnknownProviderError } from '../../src/metadata/registry.js';
import { makeFakeProvider } from '../../src/metadata/test-support.js';

describe('ProviderRegistry scoping choke-point', () => {
  it('throws RestrictedProviderScopeError: restricted provider + general library', async () => {
    const registry = new ProviderRegistry();
    const restricted = makeFakeProvider({ name: 'fake-restricted', contentClass: 'restricted' });
    registry.register(restricted);

    await expect(
      registry.search('fake-restricted', 'general', { mediaKind: 'movie', title: 'x' })
    ).rejects.toThrow(RestrictedProviderScopeError);
    await expect(
      registry.fetchDetails('fake-restricted', 'general', {
        provider: 'fake-restricted',
        externalId: '1',
        mediaKind: 'movie',
      })
    ).rejects.toThrow(RestrictedProviderScopeError);
    await expect(
      registry.fetchImages('fake-restricted', 'general', {
        provider: 'fake-restricted',
        externalId: '1',
        mediaKind: 'movie',
      })
    ).rejects.toThrow(RestrictedProviderScopeError);
  });

  it('allows: general provider + restricted library', async () => {
    const registry = new ProviderRegistry();
    const general = makeFakeProvider({ name: 'fake-general', contentClass: 'general' });
    registry.register(general);

    const results = await registry.search('fake-general', 'restricted', { mediaKind: 'movie', title: 'x' });
    expect(Array.isArray(results)).toBe(true);
  });

  it('allows: restricted provider + restricted library', async () => {
    const registry = new ProviderRegistry();
    const restricted = makeFakeProvider({ name: 'fake-restricted-2', contentClass: 'restricted' });
    registry.register(restricted);

    const results = await registry.search('fake-restricted-2', 'restricted', { mediaKind: 'movie', title: 'x' });
    expect(Array.isArray(results)).toBe(true);
  });

  it('allows: general provider + general library', async () => {
    const registry = new ProviderRegistry();
    const general = makeFakeProvider({ name: 'fake-general-2', contentClass: 'general' });
    registry.register(general);

    const results = await registry.search('fake-general-2', 'general', { mediaKind: 'movie', title: 'x' });
    expect(Array.isArray(results)).toBe(true);
  });

  it('throws UnknownProviderError for an unregistered provider name', async () => {
    const registry = new ProviderRegistry();
    await expect(
      registry.search('nope', 'general', { mediaKind: 'movie', title: 'x' })
    ).rejects.toThrow(UnknownProviderError);
  });

  it('forKind() filters by media kind', () => {
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ name: 'movie-only', kinds: ['movie'] }));
    registry.register(makeFakeProvider({ name: 'tv-only', kinds: ['tv'] }));
    expect(registry.forKind('movie').map((p) => p.name)).toEqual(['movie-only']);
    expect(registry.forKind('tv').map((p) => p.name)).toEqual(['tv-only']);
  });

  it('disabledProviders() surfaces every registered-but-disabled provider with its reason', () => {
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ name: 'enabled-one' }));
    registry.register(makeFakeProvider({ name: 'disabled-one', enabled: false, disabledReason: 'no api key' }));

    expect(registry.disabledProviders()).toEqual([{ name: 'disabled-one', reason: 'no api key' }]);
  });
});
