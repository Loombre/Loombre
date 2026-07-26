// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/registry.ts
//
// ProviderRegistry (P1.6, docs/PLAN.md §6.4's "scanner refuses to run a
// restricted provider against a general library"). `assertScope` is the
// single choke-point every provider call passes through — search(),
// fetchDetails(), and fetchImages() below are the only three entry points
// the rest of the codebase uses to reach a registered provider, and every
// one of them calls this same private method before touching the provider.
// There is no other path to a MetadataProvider's methods from outside this
// file, so the scoping check cannot be bypassed by construction (mirrors
// the packages/db query-guard's "single mandatory choke-point" design).

import type { ContentClass, MediaKind, MetadataProvider, ProviderDetails, ProviderImageRef, ProviderRef, ProviderSearchResult, SearchQuery } from './provider.js';

/**
 * Thrown by the registry's choke-point when a caller tries to run a
 * `contentClass: 'restricted'` provider against a library whose content
 * class is 'general'. A restricted item can never live in a general
 * library (docs/PLAN.md §6.3), so this direction is a hard error, never a
 * silent downgrade. The reverse — a general provider serving a restricted
 * library — is allowed (a restricted library's items may still want, e.g.,
 * TMDB metadata).
 */
export class RestrictedProviderScopeError extends Error {
  readonly providerName: string;
  readonly providerContentClass: ContentClass;
  readonly libraryContentClass: ContentClass;

  constructor(providerName: string, providerContentClass: ContentClass, libraryContentClass: ContentClass) {
    super(
      `metadata provider "${providerName}" is scoped to content_class="${providerContentClass}" ` +
        `and cannot be run against a library with content_class="${libraryContentClass}"`
    );
    this.name = 'RestrictedProviderScopeError';
    this.providerName = providerName;
    this.providerContentClass = providerContentClass;
    this.libraryContentClass = libraryContentClass;
  }
}

export class UnknownProviderError extends Error {
  constructor(name: string) {
    super(`metadata provider "${name}" is not registered`);
    this.name = 'UnknownProviderError';
  }
}

export interface DisabledProviderNotice {
  name: string;
  reason: string;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, MetadataProvider>();

  register(provider: MetadataProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): MetadataProvider | undefined {
    return this.providers.get(name);
  }

  /** Every provider registered for a given media kind, in registration order
   *  — used by the metadata consumer to walk a kind's fallback chain
   *  (movies: tmdb; tv: tmdb -> tvdb; music: musicbrainz). */
  forKind(kind: MediaKind): MetadataProvider[] {
    return [...this.providers.values()].filter((p) => p.kinds.includes(kind));
  }

  /** Admin-notice surface (P1.9): every registered provider that constructed
   *  successfully but is inert because a required API key is absent. */
  disabledProviders(): DisabledProviderNotice[] {
    return [...this.providers.values()]
      .filter((p) => !p.enabled)
      .map((p) => ({ name: p.name, reason: p.disabledReason ?? 'disabled' }));
  }

  /** THE single choke-point (see file header). Every other private/public
   *  method that reaches into a provider's methods must route through this. */
  private assertScope(provider: MetadataProvider, libraryContentClass: ContentClass): void {
    if (provider.contentClass === 'restricted' && libraryContentClass === 'general') {
      throw new RestrictedProviderScopeError(provider.name, provider.contentClass, libraryContentClass);
    }
  }

  private require(name: string): MetadataProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new UnknownProviderError(name);
    }
    return provider;
  }

  async search(
    providerName: string,
    libraryContentClass: ContentClass,
    query: SearchQuery
  ): Promise<ProviderSearchResult[]> {
    const provider = this.require(providerName);
    this.assertScope(provider, libraryContentClass);
    return provider.search(query);
  }

  async fetchDetails(
    providerName: string,
    libraryContentClass: ContentClass,
    ref: ProviderRef
  ): Promise<ProviderDetails> {
    const provider = this.require(providerName);
    this.assertScope(provider, libraryContentClass);
    return provider.fetchDetails(ref);
  }

  async fetchImages(
    providerName: string,
    libraryContentClass: ContentClass,
    ref: ProviderRef
  ): Promise<ProviderImageRef[]> {
    const provider = this.require(providerName);
    this.assertScope(provider, libraryContentClass);
    return provider.fetchImages(ref);
  }
}
