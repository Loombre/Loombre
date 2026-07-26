// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/acme/directory-urls.ts
//
// Thin re-export boundary: everything outside this file that needs an
// ACME directory URL reads it off the already-resolved TlsConfigAcme
// (config.ts inlines the two well-known Let's Encrypt URLs so it never
// needs to import acme-client just to parse LOOMBRE_TLS_MODE=off). This
// module exists only so a directory-urls.spec.ts can assert config.ts's
// inlined literals haven't drifted from acme-client's own `directory`
// export — a real dependency-freshness check, not duplicated trust.

import { directory as acmeDirectory } from "acme-client";

export { acmeDirectory };
