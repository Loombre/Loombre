// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/enums.ts
//
// Mirrors @loombre/shared's `MediaKind` and `ContentClass` verbatim
// (packages/shared/src/enums.ts), the same way apps/worker/src/metadata/
// provider.ts's own extension-point boundary does (that file's header:
// "Mirrors @loombre/shared's MediaKind verbatim") rather than adding a
// workspace dependency on @loombre/shared — LPP is a FROZEN, externally-
// consumed wire contract (this lane's mission: "The contract you produce
// FREEZES FIRST"); it deliberately does not import ANY other Loombre
// workspace package, so nothing internal can ever change its meaning out
// from under a third-party plugin author. If @loombre/shared's enums ever
// diverge from these, that is a breaking wire change and must be handled
// like any other LPP v2 concern (version.ts), not a silent transitive
// update.

import { z } from "zod";

/** Library media kind (packages/shared/src/enums.ts MediaKind, PG media_kind
 *  enum, contract MediaKind — all verbatim). */
export type LppMediaKind = "movie" | "tv" | "music";

export const LPP_MEDIA_KINDS: readonly LppMediaKind[] = ["movie", "tv", "music"];

export const LppMediaKindSchema = z.enum(["movie", "tv", "music"]);

/** packages/shared/src/enums.ts ContentClass, verbatim (C5: capability
 *  content-class scoping is capability-uniform). */
export type LppContentClass = "general" | "restricted";

export const LPP_CONTENT_CLASSES: readonly LppContentClass[] = ["general", "restricted"];

export const LppContentClassSchema = z.enum(["general", "restricted"]);
