// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/acme/directory-urls.spec.ts
//
// config.ts inlines the two well-known Let's Encrypt directory URLs so
// mode=off never pulls in acme-client's dependency graph. This is the
// drift check: if acme-client ever changes its own `directory.letsencrypt`
// constants, this test (which DOES import acme-client) fails loudly
// instead of Loombre silently pointing at a stale URL.

import { describe, expect, it } from "vitest";
import { DEFAULT_ACME_DIRECTORY_URL_PRODUCTION, DEFAULT_ACME_DIRECTORY_URL_STAGING } from "../config.js";
import { acmeDirectory } from "./directory-urls.js";

describe("config.ts's inlined LE directory URLs match acme-client's own constants", () => {
  it("production", () => {
    expect(DEFAULT_ACME_DIRECTORY_URL_PRODUCTION).toBe(acmeDirectory.letsencrypt.production);
  });

  it("staging", () => {
    expect(DEFAULT_ACME_DIRECTORY_URL_STAGING).toBe(acmeDirectory.letsencrypt.staging);
  });
});
