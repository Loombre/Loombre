// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-dns-resolver.service.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5/RG11, Lane P1 mission item 5:
// "resolve the expected endpoint's hostname via node:dns (handle NXDOMAIN
// as its own signal)").
//
// A real node:dns/promises Resolver — same class dns01-hook.ts's
// pollTxtRecordVisible already uses (apps/server/src/tls/acme/
// dns01-hook.ts), NOT the OS-resolver-backed dns.lookup(), specifically
// because Resolver#setServers lets tests point this at a real, tiny local
// UDP server instead of depending on live internet DNS — see
// remote-dns-resolver.service.spec.ts, which mirrors dns01-hook.spec.ts's
// own "closed local port -> real lookup failure" technique. This is an
// injectable Nest service (not a plain function) so
// apps/server/test/remote-probes.e2e.spec.ts can `vi.spyOn` it exactly the
// way password-recovery.e2e.spec.ts spies on MailConfigService.isConfigured
// — the established seam-testing pattern in this codebase.
//
// ANY resolution failure (NXDOMAIN, ENODATA, timeout, connection refused —
// the DiagnosisCode union has no dedicated "does not resolve at all" code)
// collapses to `null`; diagnose-reachability.ts treats that as its own
// dnsMismatch-flavored signal (task item 5's "handle NXDOMAIN as its own
// signal") rather than silently falling through with an empty address.

import { Injectable } from "@nestjs/common";
import { Resolver } from "node:dns/promises";

@Injectable()
export class RemoteDnsResolverService {
  /**
   * Resolves `hostname`'s first IPv4 address, or `null` on ANY failure.
   * `resolverAddresses` (host:port strings, e.g. "127.0.0.1:19999") is a
   * TEST-ONLY seam — production callers never pass it, leaving the
   * Resolver on its default (OS-configured) nameservers.
   */
  async resolvePublicAddress(hostname: string, resolverAddresses?: readonly string[]): Promise<string | null> {
    // Bounded (3s, single try, no retry storm) — this runs on an
    // interactive admin request (diagnoseRemote) or a poll (getRemoteProbe
    // once a token is 'expired'), never a hot catalog-read path (Tier-0,
    // CLAUDE.md invariant 9 doesn't apply here), but an unbounded c-ares
    // default retry/timeout schedule (multiple seconds per try, several
    // tries) would still make a broken DNS setup feel like a hang.
    const resolver = new Resolver({ timeout: 3000, tries: 1 });
    if (resolverAddresses && resolverAddresses.length > 0) {
      resolver.setServers([...resolverAddresses]);
    }
    try {
      const addresses = await resolver.resolve4(hostname);
      return addresses[0] ?? null;
    } catch {
      return null;
    }
  }
}
