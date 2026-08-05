// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-state.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG15, lane WG2 — item 6 of this
// lane's own mission: "THEN implement getRemoteState for real, replacing
// the LAST 501"). GET /admin/remote/state (getRemoteState) — the wizard
// re-entry read.
//
// Composes the three per-path status reads (RemoteState schema, frozen
// Wave-0: `{activePath, wireguard, tunnel, direct}`) plus the canonical
// resolveActivePath()-backed RemoteActivePathReader (WG2 integration
// unification — the SAME derivation RemoteWireguardService's
// assertNoOtherRemotePathActive, RemoteTunnelService's own 409 check, and
// RemoteDirectController's own 409 check all use, so this read can never
// disagree with what any of the three staged enable flows just enforced).
// wireguard/tunnel come straight from their own services' existing status
// methods (RemoteWireguardStatusDto/RemoteTunnelStatusDto both already
// match the contract's schemas byte-for-byte); direct has no dedicated
// status op on the frozen 3-op Direct surface (acme-test/enable/disable
// only), so remote-direct.controller.ts exports buildRemoteDirectStatus
// for exactly this composition (see that file's own header).

import { Controller, Get, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { SettingsService } from "../settings/settings.service.js";
import { requireAdmin } from "./require-admin.js";
import { RemoteActivePathReader, type RemotePathId } from "./active-path-reader.js";
import { RemoteWireguardService, type RemoteWireguardStatusDto } from "./wireguard/remote-wireguard.service.js";
import { RemoteTunnelService, type RemoteTunnelStatusDto } from "./tunnel/remote-tunnel.service.js";
import { buildRemoteDirectStatus, type RemoteDirectStatusDto } from "./remote-direct.controller.js";

export interface RemoteStateDto {
  activePath: RemotePathId;
  wireguard: RemoteWireguardStatusDto;
  tunnel: RemoteTunnelStatusDto;
  direct: RemoteDirectStatusDto;
}

@Controller()
export class RemoteStateController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly settingsService: SettingsService,
    private readonly activePathReader: RemoteActivePathReader,
    private readonly wireguardService: RemoteWireguardService,
    private readonly tunnelService: RemoteTunnelService,
  ) {}

  @Get("admin/remote/state")
  async getRemoteState(@Req() req: AuthenticatedRequest): Promise<RemoteStateDto> {
    await requireAdmin(this.dbProvider.db, req);

    const [activePath, wireguard, tunnel, direct] = await Promise.all([
      this.activePathReader.activePath(),
      this.wireguardService.status(),
      this.tunnelService.getRemoteTunnelStatus(),
      buildRemoteDirectStatus(this.dbProvider.db, this.settingsService),
    ]);

    return { activePath, wireguard, tunnel, direct };
  }
}
