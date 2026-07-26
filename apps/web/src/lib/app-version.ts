// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/app-version.ts
//
// Single-source version stamping (STATE.md P4.11): root package.json's
// `version` field is authoritative — packages/shared/src/version.ts
// (server-side; consumed by the admin-only GET /system/info and
// `loombre --version`) derives its generated LOOMBRE_VERSION_FULL from the
// exact same field. apps/web can't import that generated package without
// adding a brand-new workspace dependency edge (this lane's "no new
// dependencies" hard line, and package.json is otherwise untouched by this
// lane), and /system/info itself is admin-only (401/403 for a non-admin
// token) — but the Phosphor sidebar's "MEDIA SERVER · V<version>" line
// (README shell spec) renders for EVERY signed-in user, admin or not.
//
// Reading the root package.json directly — a plain JSON import, resolved
// at build time by webpack/Next's native JSON-module support
// (tsconfig.base.json's resolveJsonModule) — is the one source both
// audiences can reach without a new dependency or a packages/** change.
// This intentionally reports the bare semver (e.g. "0.9.0"), not the
// server's "<version>-dev+<shorthash>" build stamp — the web bundle itself
// isn't the thing carrying a dev/release build suffix.

import pkg from "../../../../package.json";

export const APP_VERSION: string = pkg.version;
