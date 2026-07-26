// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-plugin-preview.service.ts
//
// Lane W5: POST /admin/plugins/preview's logic — C4's confirmation-screen
// data source. W2 (plugin-registration.service.ts) has no standalone
// "fetch + validate, do not persist" entry point of its own (its
// registerPlugin() always goes on to mint a keyring secret and write a
// row), so this is a NEW, small, thin service reusing @loombre/plugin-host's
// fetchPluginManifest exactly the way registerPlugin's own first step does
// (same SSRF-guarded transport, same staged parseLppManifest, no breaker —
// there is no plugin row yet). Nothing here writes to the database or the
// keyring.
//
// File lives alongside W2's plugin-*.service.ts (the natural home for
// plugin-related server code) but is deliberately named admin-plugin-*.ts
// to mark it as this lane's own addition, not a W2 file.

import { Injectable } from "@nestjs/common";
import { describeFetchManifestFailure, fetchPluginManifest } from "@loombre/plugin-host";
import { type LppEventSubscriberCapability } from "@loombre/plugin-protocol";
import { DbProvider } from "../common/db.provider.js";
import { unprocessableEntity } from "../gateway/problem.exception.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import type { PluginManifestPreviewDto } from "./admin-plugin-dto.js";
import { computeManifestDigest } from "./manifest-digest.js";

/** Mirrors plugin-registration.service.ts's own validateBaseUrl exactly
 *  (that function is module-private there, not exported — duplicated here
 *  rather than widening that file's surface for one caller, per this
 *  lane's "consume W2 services, don't edit them" constraint). */
function validateBaseUrl(rawUrl: unknown, instancePath: string): URL {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw unprocessableEntity("url is required.", instancePath);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw unprocessableEntity("url must be an absolute URL.", instancePath);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw unprocessableEntity("url must use the http or https scheme.", instancePath);
  }
  return parsed;
}

@Injectable()
export class AdminPluginPreviewService {
  constructor(private readonly dbProvider: DbProvider) {}

  async preview(rawUrl: unknown, lanAllowlist: string[], actorUserId: string): Promise<PluginManifestPreviewDto> {
    const instancePath = "/admin/plugins/preview";
    await requireLiveAdmin(this.dbProvider.db, actorUserId, instancePath);

    const parsedUrl = validateBaseUrl(rawUrl, instancePath);
    const baseUrl = parsedUrl.origin;

    const manifestResult = await fetchPluginManifest(baseUrl, { lanAllowlist });
    if (!manifestResult.ok) {
      throw unprocessableEntity(describeFetchManifestFailure(manifestResult), instancePath);
    }
    const { manifest } = manifestResult;

    const requestedEventTypes = [
      ...new Set(
        manifest.capabilities
          .filter((c): c is LppEventSubscriberCapability => c.type === "event-subscriber")
          .flatMap((c) => c.eventTypes),
      ),
    ];

    return {
      name: manifest.name,
      version: manifest.version,
      protocolVersion: manifest.protocolVersion,
      publisher: manifest.publisher,
      description: manifest.description,
      capabilities: manifest.capabilities,
      configSchema: manifest.configSchema,
      requestedEventTypes,
      // C-2 fix wave: a canonical digest of the EXACT manifest content this
      // preview validated. register()/reapprove() require the caller to
      // round-trip this value and 409 if a fresh fetch no longer matches it
      // — see manifest-digest.ts's header for the full rationale.
      manifestDigest: computeManifestDigest(manifest),
    };
  }
}
