// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/defaults.ts
//
// The embedded-deployment defaults BOTH halves of the single-provisioner
// rule (STATE.md P4.2) must agree on: the supervisor (writer — provisions
// the cluster, generates the secret) and discovery.ts (reader — a sibling
// process like apps/worker reconstructing the same DATABASE_URL). They
// live in one module so the two can never drift apart. apps/server's
// bootstrap re-exports EMBEDDED_PG_DEFAULT_PORT from here rather than
// pinning its own copy.

export const EMBEDDED_PG_DEFAULT_PORT = 5433;
export const EMBEDDED_PG_SUPERUSER_USERNAME = "loombre";
export const EMBEDDED_PG_DEFAULT_DATABASE = "loombre";
