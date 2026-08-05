// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-probes.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R6/RG6, Lane P1). Two ADMIN ops (tag
// `remote`, packages/contract/openapi.yaml) — the mint and poll sides of
// the reachability proof; the PUBLIC arrival side (GET /probe/{token})
// lives in probe-page.controller.ts, deliberately separate (a different
// auth posture deserves a different file, same reasoning
// invites.controller.ts's admin-vs-public split inside one module
// documents, applied here as a file split since this whole module is
// brand new):
//   - POST /admin/remote/probes         createRemoteProbe
//   - GET  /admin/remote/probes/{id}    getRemoteProbe
//
// createRemoteProbe (RG6): mints `randomBytes(32).toString("base64url")` —
// the plaintext token appears ONLY in this response, embedded in
// probeUrl/qrPayload, and is NEVER persisted (only its SHA-256 hex hash
// is, via mintProbeToken). 15-minute expiry (R6).
//
// getRemoteProbe: poll shape {status, arrivedAtMs, diagnosis} — status is
// ALWAYS derived (packages/db/src/query/remote-probes.ts's
// deriveProbeStatus), never stored stale. `diagnosis` is populated ONLY
// once status is definitively 'expired' (never arrived, expiry passed) —
// computed via the SAME diagnoseReachability orchestration diagnoseRemote
// uses (diagnose-reachability.ts), with `wanAddress: null` (this is an
// AUTOMATIC poll-time diagnosis — no admin-supplied WAN address exists
// here; a richer diagnosis with a real wanAddress is what
// POST /admin/remote/diagnosis is for).

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { getProbeTokenById, mintProbeToken, deriveProbeStatus } from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";
import { diagnoseReachability } from "./diagnose-reachability.js";
import { ConnectorHealthReaderService } from "./connector-health.service.js";
import { RemoteDnsResolverService } from "./remote-dns-resolver.service.js";
import { isRemoteProbePath } from "./remote-probe-path.js";

const PROBE_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes (R6).
const CREATE_PROBE_BODY_KEYS = new Set(["expectedEndpoint", "path"]);

@Controller()
export class RemoteProbesController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly connectorHealthReader: ConnectorHealthReaderService,
    private readonly dnsResolver: RemoteDnsResolverService,
  ) {}

  @Post("admin/remote/probes")
  @HttpCode(HttpStatus.CREATED)
  async createRemoteProbe(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    const db = this.dbProvider.db;
    await requireAdmin(db, req);
    const instance = req.originalUrl;
    const body = rawBody ?? {};

    for (const key of Object.keys(body)) {
      if (!CREATE_PROBE_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }
    if (typeof body["expectedEndpoint"] !== "string" || body["expectedEndpoint"].length === 0) {
      throw unprocessableEntity("expectedEndpoint is required.", instance);
    }
    if (!isRemoteProbePath(body["path"])) {
      throw unprocessableEntity("path is required and must be one of: remote, tunnel, direct.", instance);
    }

    const nowMs = clockNowMs();
    const token = randomBytes(32).toString("base64url"); // RG6 — plaintext appears ONLY in this response.
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAtMs = nowMs + PROBE_TOKEN_TTL_MS;

    const row = await mintProbeToken(db, {
      tokenHash,
      expectedEndpoint: body["expectedEndpoint"],
      path: body["path"],
      createdBy: req.user!.userId,
      createdAtMs: nowMs,
      expiresAtMs,
    });

    const probeUrl = `https://${body["expectedEndpoint"]}/probe/${token}`;
    return {
      id: row.id,
      probeUrl,
      // RG8: identical to probeUrl today — kept as a distinct field per
      // Wave-0 shape decision #3 (a future non-URL QR payload wouldn't be
      // a breaking contract change).
      qrPayload: probeUrl,
      expiresAtMs: row.expires_at_ms,
    };
  }

  @Get("admin/remote/probes/:id")
  async getRemoteProbe(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    const db = this.dbProvider.db;
    await requireAdmin(db, req);
    requireUuidParam(id, "Probe not found.", req.originalUrl);

    const row = await getProbeTokenById(db, id);
    if (!row) {
      throw notFound("Probe not found.", req.originalUrl);
    }

    const nowMs = clockNowMs();
    const status = deriveProbeStatus({ arrivedAtMs: row.arrived_at_ms, expiresAtMs: row.expires_at_ms }, nowMs);

    let diagnosis = null;
    if (status === "expired") {
      diagnosis = await diagnoseReachability(
        { path: row.path, expectedEndpoint: row.expected_endpoint, wanAddress: null },
        { connectorHealthReader: this.connectorHealthReader, dnsResolver: this.dnsResolver },
      );
    }

    return {
      id: row.id,
      status,
      arrivedAtMs: row.arrived_at_ms,
      diagnosis,
    };
  }
}
