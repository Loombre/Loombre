// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/mail/mail-config.service.ts
//
// Optional mail transport run, M7/M8: FROZEN cross-lane seam #2 —
// `MailConfigService` exposes `isConfigured(): boolean` and
// `publicUrl(): string | null`, both HOT (SettingsService.getEffective is
// an in-memory cache updated on every settings write, A5 — no restart, no
// re-read from the database on this call path). Lanes A/B (invitations,
// password recovery) inject this directly wherever they need to know
// whether the email tier is active or need publicUrl() to build a
// security-sensitive link (E7: mail links are built ONLY from this value,
// never a request's Host header).
//
// M8: "configured" := effective mail.smtpHost non-empty AND
// mail.fromAddress non-empty AND network.publicUrl set. Credentials are
// DELIBERATELY excluded from this definition — unauthenticated SMTP (a
// private-network relay) is a fully legal configuration (M8's own
// wording), so mail-credentials.service.ts's status is never consulted
// here.
//
// publicUrl() strips a trailing slash defensively at THIS read site —
// packages/shared/src/settings-registry.ts's PUBLIC_URL_SCHEMA validates
// but does not normalize (zod v4's `z.toJSONSchema()`, which the admin
// UI's form renderer depends on, cannot represent a `.transform()` — see
// that schema's own header for the verified error). Normalizing here
// covers a trailing slash arriving via ANY source uniformly (an env pin,
// a database row written before this lane existed, or a value some other
// future writer never normalized) — not just a value freshly written
// through PUT /admin/settings/{key}.

import { Injectable } from "@nestjs/common";
import { SettingsService } from "../settings/settings.service.js";

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

@Injectable()
export class MailConfigService {
  constructor(private readonly settingsService: SettingsService) {}

  isConfigured(): boolean {
    const smtpHost = this.settingsService.getEffective("mail.smtpHost")?.value;
    const fromAddress = this.settingsService.getEffective("mail.fromAddress")?.value;
    return nonEmptyString(smtpHost) && nonEmptyString(fromAddress) && this.publicUrl() !== null;
  }

  publicUrl(): string | null {
    const raw = this.settingsService.getEffective("network.publicUrl")?.value;
    if (!nonEmptyString(raw)) return null;
    return raw.replace(/\/+$/, "");
  }
}
