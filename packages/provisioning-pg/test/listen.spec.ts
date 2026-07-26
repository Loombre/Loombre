// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { buildServerListenArgs, buildClientConnArgs, buildDatabaseUrl } from "../src/listen.js";
import type { ListenStrategy } from "@loombre/provisioning";

describe("buildServerListenArgs", () => {
  it("unix-socket: disables TCP and passes -k with the socket dir", () => {
    const strategy: ListenStrategy = { kind: "unix-socket", socketDir: "/tmp/loombre/sock" };
    expect(buildServerListenArgs(strategy)).toEqual(["-h", "", "-k", "/tmp/loombre/sock"]);
  });

  it("tcp-loopback: hard-codes 127.0.0.1, never any other bind address", () => {
    const strategy: ListenStrategy = { kind: "tcp-loopback", port: 35001 };
    expect(buildServerListenArgs(strategy)).toEqual(["-h", "127.0.0.1", "-p", "35001", "-c", "unix_socket_directories="]);
  });
});

describe("buildClientConnArgs", () => {
  it("unix-socket: -h <socketDir>", () => {
    expect(buildClientConnArgs({ kind: "unix-socket", socketDir: "/tmp/s" })).toEqual(["-h", "/tmp/s"]);
  });

  it("tcp-loopback: -h 127.0.0.1 -p <port>", () => {
    expect(buildClientConnArgs({ kind: "tcp-loopback", port: 35002 })).toEqual(["-h", "127.0.0.1", "-p", "35002"]);
  });
});

describe("buildDatabaseUrl", () => {
  it("unix-socket: percent-encodes the socket dir as the host component (verified live against the real `pg` driver — see this lane's report)", () => {
    const url = buildDatabaseUrl({ kind: "unix-socket", socketDir: "/tmp/a b/sock" }, "loombre", "p@ss/word", "loombre");
    expect(url).toBe(`postgres://loombre:p%40ss%2Fword@${encodeURIComponent("/tmp/a b/sock")}/loombre`);
  });

  it("tcp-loopback: standard host:port form", () => {
    const url = buildDatabaseUrl({ kind: "tcp-loopback", port: 35003 }, "loombre", "secret", "loombre");
    expect(url).toBe("postgres://loombre:secret@127.0.0.1:35003/loombre");
  });

  it("encodes special characters in user/password/database", () => {
    const url = buildDatabaseUrl({ kind: "tcp-loopback", port: 35004 }, "user name", "p/w:d", "my db");
    expect(url).toBe("postgres://user%20name:p%2Fw%3Ad@127.0.0.1:35004/my%20db");
  });
});
