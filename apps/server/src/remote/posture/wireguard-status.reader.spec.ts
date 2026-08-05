// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/wireguard-status.reader.spec.ts
//
// V-SEC finding F1 regression guard: before integration this reader
// returned `undefined` unconditionally, so gradeWgPortSilence's fail/info
// branches were dead code and a silently-dead listener was mis-graded. These
// prove the reader now maps RemoteWireguardService.status() through to the
// snapshot, and that a genuine read failure still collapses to the honest
// `undefined` (never a fabricated enabled/listening pair).

import { describe, expect, it } from "vitest";
import { WireguardStatusReaderService } from "./wireguard-status.reader.js";
import { gradeWgPortSilence } from "./checks/wg-port-silence.js";

type WgService = ConstructorParameters<typeof WireguardStatusReaderService>[0];

function readerReturning(status: unknown): WireguardStatusReaderService {
  return new WireguardStatusReaderService({ status: async () => status } as unknown as WgService);
}

function readerThrowing(): WireguardStatusReaderService {
  return new WireguardStatusReaderService({
    status: async () => {
      throw new Error("native lib unavailable");
    },
  } as unknown as WgService);
}

describe("WireguardStatusReaderService (F1: wired to RemoteWireguardService.status())", () => {
  it("maps a bound, enabled listener to {enabled:true, listening:true} → grade info (the honest ceiling)", async () => {
    const snapshot = await readerReturning({ enabled: true, listening: true, listenPort: 51820 }).read();
    expect(snapshot).toEqual({ enabled: true, listening: true });
    expect(gradeWgPortSilence(snapshot).grade).toBe("info");
  });

  it("maps an enabled-but-unbound listener to {enabled:true, listening:false} → grade FAIL (the dead-listener case F1 said was unreachable)", async () => {
    const snapshot = await readerReturning({ enabled: true, listening: false, listenPort: 51820 }).read();
    expect(snapshot).toEqual({ enabled: true, listening: false });
    expect(gradeWgPortSilence(snapshot).grade).toBe("fail");
  });

  it("collapses a throwing status() to undefined → grade warn (honest 'could not confirm', never a fabricated pair)", async () => {
    const snapshot = await readerThrowing().read();
    expect(snapshot).toBeUndefined();
    expect(gradeWgPortSilence(snapshot).grade).toBe("warn");
  });
});
