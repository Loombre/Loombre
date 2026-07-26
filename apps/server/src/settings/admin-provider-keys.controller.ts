// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/settings/admin-provider-keys.controller.ts
//
// STATE.md Addendum A, decision A9 (backend: lane S1's ProviderKeysService,
// FROZEN this lane) / A6 (contract + wiring, lane S2): PUT/DELETE
// /admin/provider-keys/{provider}. Deliberately NOT nested under
// /admin/settings/{key} — see packages/contract/openapi.yaml's comment on
// this path for the /users/{id}-shadowed-by-/users/me precedent this
// avoids.
//
// Both mutations respond 204 (no body) rather than echoing
// ProviderKeyStatusDto back on the wire: the mission's explicit contract
// spec for this lane ("GET never exists for key VALUES anywhere — statuses
// ride on GET /v1/admin/settings only") extends to these two mutations as
// well — a caller that wants the fresh status re-fetches GET
// /admin/settings, the same single source every other consumer (including
// this lane's own apps/web renderer) uses. ProviderKeysService.
// setProviderKey/clearProviderKey both still RETURN a ProviderKeyStatusDto
// (S1's frozen signature) — this controller deliberately discards it rather
// than widening the wire response. NOTE (see this lane's final report):
// settings.types.ts's own header comment lists a GET-per-provider endpoint
// and a 200-with-body PUT/DELETE — this lane's mission text explicitly
// superseded that with the write-only/204 shape implemented here; the
// comment is stale prose, not a frozen wire contract (the frozen thing is
// the TypeScript DTO shapes themselves, which are unaffected either way).
//
// Admin gating: no controller-level requireAdmin() call — both service
// methods call S1's requireLiveAdmin() (A10) as their own first step, which
// is what actually gates these mutations; see admin-settings.controller.ts's
// header for why a redundant claim-based check first would only be a
// weaker gate in front of the real one.
//
// Security review F11a: PUT now 409s (ProviderKeysService.setProviderKey,
// same problem+json shape as settings.service.ts's env-pin conflict) when
// the target provider's key is currently env-sourced — previously a PUT in
// that state silently wrote an inert keyring value nothing would ever read
// back (env always wins). See provider-keys.service.ts's own header.

import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Put, Req } from "@nestjs/common";
import { nowMs as clockNowMs } from "@loombre/shared";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { ProviderKeysService } from "./provider-keys.service.js";

@Controller("admin/provider-keys")
export class AdminProviderKeysController {
  constructor(private readonly providerKeysService: ProviderKeysService) {}

  @Put(":provider")
  @HttpCode(HttpStatus.NO_CONTENT)
  async setProviderKey(
    @Param("provider") provider: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    const body = rawBody ?? {};
    // Coerced (never thrown on a missing/non-string body field) so the
    // service's own ordered checks (requireLiveAdmin 403 -> isProviderName
    // 404 -> empty-key 422) run in full regardless of what the body looks
    // like — a bodyless/malformed request must still hit 403 first for a
    // demoted admin, exactly like updateAdminSetting.
    const key = typeof body["key"] === "string" ? body["key"] : "";
    await this.providerKeysService.setProviderKey({
      provider,
      key,
      actorUserId: req.user!.userId,
      nowMs: clockNowMs(),
      instancePath: req.originalUrl,
    });
  }

  @Delete(":provider")
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearProviderKey(@Param("provider") provider: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.providerKeysService.clearProviderKey({
      provider,
      actorUserId: req.user!.userId,
      nowMs: clockNowMs(),
      instancePath: req.originalUrl,
    });
  }
}
