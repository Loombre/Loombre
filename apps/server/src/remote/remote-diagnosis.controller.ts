// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-diagnosis.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5/R6/RG11, Lane P1). One op (tag
// `remote`, packages/contract/openapi.yaml):
//   - POST /admin/remote/diagnosis   diagnoseRemote
//
// The interactive, admin-driven diagnosis: resolves expectedEndpoint's
// hostname via node:dns, optionally takes an admin-supplied wanAddress
// (RG11 — no third-party echo service, no router APIs), consults the
// Tunnel-path connector-health short-circuit FIRST, then calls the FROZEN
// classifyReachability. All the actual logic lives in
// diagnose-reachability.ts (shared with getRemoteProbe's own
// auto-diagnosis-on-expiry, remote-probes.controller.ts) — this controller
// is validation + wiring only.

import { Body, Controller, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import { unprocessableEntity } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";
import { diagnoseReachability } from "./diagnose-reachability.js";
import { ConnectorHealthReaderService } from "./connector-health.service.js";
import { RemoteDnsResolverService } from "./remote-dns-resolver.service.js";
import { isRemoteProbePath } from "./remote-probe-path.js";

const DIAGNOSE_REMOTE_BODY_KEYS = new Set(["expectedEndpoint", "wanAddress", "path"]);

@Controller()
export class RemoteDiagnosisController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly connectorHealthReader: ConnectorHealthReaderService,
    private readonly dnsResolver: RemoteDnsResolverService,
  ) {}

  @Post("admin/remote/diagnosis")
  @HttpCode(HttpStatus.OK)
  async diagnoseRemote(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    const instance = req.originalUrl;
    const body = rawBody ?? {};

    for (const key of Object.keys(body)) {
      if (!DIAGNOSE_REMOTE_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }
    if (typeof body["expectedEndpoint"] !== "string" || body["expectedEndpoint"].length === 0) {
      throw unprocessableEntity("expectedEndpoint is required.", instance);
    }
    if (!isRemoteProbePath(body["path"])) {
      throw unprocessableEntity("path is required and must be one of: remote, tunnel, direct.", instance);
    }
    let wanAddress: string | null = null;
    if (body["wanAddress"] !== undefined && body["wanAddress"] !== null) {
      if (typeof body["wanAddress"] !== "string") {
        throw unprocessableEntity("wanAddress must be a string or null.", instance);
      }
      wanAddress = body["wanAddress"];
    }

    return diagnoseReachability(
      { path: body["path"], expectedEndpoint: body["expectedEndpoint"], wanAddress },
      { connectorHealthReader: this.connectorHealthReader, dnsResolver: this.dnsResolver },
    );
  }
}
