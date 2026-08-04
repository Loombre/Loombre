// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/notices/notices.module.ts
//
// STATE.md "Admin broadcast notifications — system notices" (NG7): own
// sibling directory to catalog/playback/session/common/setup/invites/... —
// invites.module.ts's own precedent for "a fifth-plus top-level module is
// free to be a new directory". Only CommonModule is needed here (DbProvider
// — every handler in notices.controller.ts is a thin CRUD/read over
// packages/db/src/query/notices.ts, no service layer of its own).
//
// DI hazard (prior-run lesson, STATE.md): CommonModule already PROVIDES
// DbProvider and EXPORTS it — this module must import CommonModule, never
// re-list DbProvider in its own `providers`, or Nest mints a second
// module-scoped instance that silently diverges from the one every other
// controller/test spies on.
import { Module } from "@nestjs/common";
import { NoticesController } from "./notices.controller.js";
import { CommonModule } from "../common/common.module.js";

@Module({
  imports: [CommonModule],
  controllers: [NoticesController],
})
export class NoticesModule {}
