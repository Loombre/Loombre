// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/setup/setup.module.ts
//
// Fifth sibling directory to catalog/playback/session/common (see
// common/common.module.ts's header for why "sibling, not nested" matters:
// dependency-cruiser's D2 boundary only forbids the THREE pairwise
// catalog<->playback<->session cross-imports — a new top-level module is
// free to depend on session/ directly, which this one does, for
// TokenService/RefreshTokenService (first-admin creation mints a real
// TokenPair exactly like login does).
//
// RefreshTokenService is listed in THIS module's own `providers` rather
// than imported via SessionModule's exports: SessionModule only exports
// `[CommonModule, TokenService]` (session.module.ts), not
// RefreshTokenService, and this lane's ownership is scoped to
// apps/server/src/setup/** plus a narrow auth-guard/conformance edit — not
// session.module.ts. RefreshTokenService is a stateless class (no
// constructor, no injected deps — apps/server/src/session/refresh-token.service.ts),
// so Nest instantiating a second copy scoped to this module is behaviorally
// identical to reusing SessionModule's; nothing is shared/cached that would
// make two instances diverge.
import { Module } from "@nestjs/common";
import { SetupController } from "./setup.controller.js";
import { CommonModule } from "../common/common.module.js";
import { SessionModule } from "../session/session.module.js";
import { RefreshTokenService } from "../session/refresh-token.service.js";

@Module({
  imports: [CommonModule, SessionModule],
  controllers: [SetupController],
  providers: [RefreshTokenService],
})
export class SetupModule {}
