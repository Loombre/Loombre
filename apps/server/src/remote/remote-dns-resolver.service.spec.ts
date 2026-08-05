// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-dns-resolver.service.spec.ts
//
// Real node:dns/promises resolution, zero network dependency beyond
// loopback — same technique apps/server/src/tls/acme/dns01-hook.spec.ts's
// "pollTxtRecordVisible" suite already establishes: point the Resolver at
// a closed local UDP port (a real connection-refused/no-response
// condition, never fabricated) for the failure case, and a minimal
// hand-built real DNS server for the success case.

import * as dgram from "node:dgram";
import { describe, expect, it } from "vitest";
import { RemoteDnsResolverService } from "./remote-dns-resolver.service.js";

describe("RemoteDnsResolverService.resolvePublicAddress", () => {
  it("returns null when nothing answers (real DNS resolution against loopback, nothing listening — the NXDOMAIN-class failure this service treats as its own signal)", async () => {
    const service = new RemoteDnsResolverService();
    const address = await service.resolvePublicAddress("loombre-remote-dns-test.invalid", ["127.0.0.1:19998"]);
    expect(address).toBeNull();
  });

  it("returns the first A record once a real (tiny, local) DNS server answers", async () => {
    const hostname = "loombre-remote-dns-test.invalid";
    const expectedIp = "203.0.113.42";

    // A minimal real DNS server: a real UDP wire-protocol responder that
    // parses the incoming query's id + question and builds a real A
    // answer section — not a stub of resolvePublicAddress itself (same
    // technique dns01-hook.spec.ts's own TXT responder uses).
    const socket = dgram.createSocket("udp4");
    socket.on("message", (msg, rinfo) => {
      const id = msg.subarray(0, 2);
      const question = msg.subarray(12);
      const answerName = Buffer.from([0xc0, 0x0c]); // pointer to the question's name
      const rdata = Buffer.from(expectedIp.split(".").map(Number));
      const answer = Buffer.concat([
        answerName,
        Buffer.from([0x00, 0x01]), // TYPE=A
        Buffer.from([0x00, 0x01]), // CLASS=IN
        Buffer.from([0x00, 0x00, 0x00, 0x01]), // TTL=1
        Buffer.from([0x00, rdata.length]),
        rdata,
      ]);
      const header = Buffer.from([id[0]!, id[1]!, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
      socket.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address);
    });

    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    const address = socket.address();

    try {
      const service = new RemoteDnsResolverService();
      const resolved = await service.resolvePublicAddress(hostname, [`127.0.0.1:${address.port}`]);
      expect(resolved).toBe(expectedIp);
    } finally {
      socket.close();
    }
  });
});
