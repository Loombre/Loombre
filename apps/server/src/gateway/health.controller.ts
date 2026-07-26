// SPDX-License-Identifier: AGPL-3.0-only
import { Controller, Get } from "@nestjs/common";

interface HealthResponse {
  status: "ok";
  timestampMs: number;
}

/**
 * Liveness probe only. NOT part of the public /v1 contract — the API surface
 * comes from packages/contract/openapi.yaml (later wave); do not add routes
 * here that belong in the contract.
 *
 * STATE.md P4.15 (Phase 4 lane G1's rate-limit sweep) DECISION, documented
 * per the task spec's explicit "decide + document: exempt-with-rationale or
 * high-ceiling" instruction: /healthz is EXEMPT from rate limiting, not
 * given a high-ceiling policy. Rationale — this handler does zero DB/I/O
 * work (a bare object literal + Date.now()), so there is no amplification
 * cost a limiter would meaningfully mitigate; meanwhile container
 * orchestrators, systemd watchdog units, and load balancers are EXPECTED to
 * poll this route every few seconds by design (Docker HEALTHCHECK,
 * Kubernetes liveness/readiness probes, `loombre doctor`) — attaching even a
 * generous limiter here risks a false-positive "unhealthy" verdict from
 * legitimate infrastructure, which is a correctness regression, not a
 * security improvement. This is the ONE unauthenticated surface in the
 * P4.15 sweep that stays deliberately unlimited.
 */
@Controller()
export class HealthController {
  @Get("healthz")
  healthz(): HealthResponse {
    return { status: "ok", timestampMs: Date.now() };
  }
}
