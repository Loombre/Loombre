// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/tls/pebble/pebble-env.ts
//
// Shared setup helpers for the REAL pebble ACME integration suites.
// Nothing in this file is a mock — every function here either shells out
// to real `docker` commands against the lane's own `loombre_f` compose
// project (test/tls/pebble/docker-compose.yml) or makes a real HTTP call
// to pebble-challtestsrv's real management API.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";
import { Http01ChallengeServer } from "../../../src/tls/acme/http01-server.js";

const execFileAsync = promisify(execFile);

export const PEBBLE_DIRECTORY_URL = "https://127.0.0.1:3600/dir";
export const PEBBLE_MANAGEMENT_URL = "https://127.0.0.1:3601";
export const CHALLTESTSRV_MANAGEMENT_URL = "http://127.0.0.1:3602";
export const CHALLTESTSRV_DNS_ADDRESS = "127.0.0.1:3603";
export const PEBBLE_CONTAINER_NAME = "loombre_f-pebble-1";
const ACME_NETWORK = "loombre_f_acmenet";

async function candidateHostIps(): Promise<string[]> {
  const candidates: string[] = [];

  // Docker's host-gateway magic address — reliable on Linux (incl. the
  // ubuntu CI runners this repo targets); empirically UNRELIABLE from a
  // custom user-defined bridge network under Docker Desktop for Mac (this
  // lane's own dev box), which is exactly why this function doesn't stop
  // here and instead verifies every candidate for real before returning
  // one (see resolveReachableHostIp below).
  try {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--add-host=host.docker.internal:host-gateway",
      "alpine",
      "getent",
      "hosts",
      "host.docker.internal",
    ]);
    for (const line of stdout.trim().split("\n")) {
      const ip = line.trim().split(/\s+/)[0];
      if (ip !== undefined && ip.includes(".")) candidates.push(ip); // IPv4 only — Http01ChallengeServer binds 0.0.0.0
    }
  } catch {
    // docker unreachable or getent failed — fall through to interface IPs
  }

  // Every non-internal IPv4 address this host actually has — reachable
  // from a docker bridge network via ordinary host routing regardless of
  // host-gateway support.
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === "IPv4" && !addr.internal) candidates.push(addr.address);
    }
  }

  return [...new Set(candidates)];
}

/** Starts a REAL, throwaway Http01ChallengeServer (the exact class
 *  production code uses) on `port`, registers a marker token, then probes
 *  each candidate host IP from a REAL container attached to the pebble
 *  compose project's own `acmenet` network — the same path pebble itself
 *  will take to reach Loombre's challenge listener during real HTTP-01
 *  validation. Returns the first candidate that a container on that
 *  network can actually reach. */
export async function resolveReachableHostIp(port: number): Promise<string> {
  const probe = new Http01ChallengeServer({ host: "0.0.0.0" });
  await probe.listen(port);
  const token = "reachability-probe";
  const expected = "reachable";
  probe.register(token, expected);

  try {
    const candidates = await candidateHostIps();
    for (const ip of candidates) {
      try {
        const { stdout } = await execFileAsync(
          "docker",
          [
            "run",
            "--rm",
            "--network",
            ACME_NETWORK,
            "curlimages/curl",
            "-sS",
            "--max-time",
            "3",
            `http://${ip}:${String(port)}/.well-known/acme-challenge/${token}`,
          ],
          { timeout: 8000 },
        );
        if (stdout.trim() === expected) return ip;
      } catch {
        // this candidate isn't reachable from the acmenet network — try the next
      }
    }
    throw new Error(
      `none of the candidate host IPs (${candidates.join(", ") || "<none found>"}) are reachable from a container ` +
        `on the "${ACME_NETWORK}" docker network — is "docker compose -f test/tls/pebble/docker-compose.yml up -d" running?`,
    );
  } finally {
    await probe.close();
  }
}

/** The static trust anchor for pebble's OWN HTTPS listeners (the ACME API
 *  on 3600 AND the management API on 3601 — both share the same
 *  `test/certs/localhost/{cert,key}.pem` per pebble-config.json). This is
 *  baked into the image at `/test/certs/pebble.minica.pem` and does NOT
 *  change across restarts. Copied straight out of the running container's
 *  filesystem (docker cp needs no shell inside the target — pebble's
 *  official image is FROM scratch and has none).
 *
 *  IMPORTANT — this is NOT the trust anchor for certificates pebble
 *  ISSUES via ACME: pebble generates a FRESH root+intermediate on every
 *  process start ("Generated new root issuer CN=Pebble Root CA ..." in
 *  its boot log) specifically for signing issued certs. That one has to
 *  be fetched from the management API at runtime — see
 *  fetchPebbleAcmeIssuanceRootPem below. Conflating the two looks
 *  identical right up until you try to verify an issued certificate's
 *  chain against this file and get a real, confusing
 *  "unable to get local issuer certificate" (found the hard way while
 *  building this suite — the account/order/challenge calls all succeed
 *  against pebble's API using THIS trust anchor, which is what makes the
 *  mistake easy to miss until the very last verification step). */
export async function fetchPebbleListenerCaPem(containerName: string = PEBBLE_CONTAINER_NAME): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["cp", `${containerName}:/test/certs/pebble.minica.pem`, "-"]);
  // `docker cp <src> -` streams a tar archive to stdout, not the raw file.
  // The PEM itself is ASCII and self-delimited by its BEGIN/END markers,
  // which survive untouched inside the tar's data blocks — trivial to
  // extract without a tar-parsing dependency.
  const match = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(stdout);
  if (match === null) {
    throw new Error("could not extract pebble.minica.pem from `docker cp` tar stream");
  }
  return `${match[0]}\n`;
}

/** The trust anchor for certificates pebble ISSUES via ACME (see the long
 *  comment on fetchPebbleListenerCaPem for why this is a separate CA from
 *  pebble's own listener cert). Fetched from the management API's
 *  `/roots/0` endpoint — reachable only by first trusting the listener CA
 *  above, since the management API is itself HTTPS. Uses `node:https`
 *  directly rather than the global `fetch` (Node's fetch is undici-based
 *  and doesn't accept a plain `https.Agent`/`ca` option the way the
 *  `http`/`https` modules do). */
export async function fetchPebbleAcmeIssuanceRootPem(): Promise<string> {
  const listenerCa = await fetchPebbleListenerCaPem();
  const https = await import("node:https");
  return new Promise<string>((resolve, reject) => {
    https.get(`${PEBBLE_MANAGEMENT_URL}/roots/0`, { ca: listenerCa }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`pebble management API /roots/0 returned ${String(res.statusCode)}`));
        res.resume();
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

/** Points challtestsrv's fake DNS server at `ip` for A queries for
 *  `domain` — this is what makes pebble (configured with `-dnsserver
 *  10.30.50.3:8053` in docker-compose.yml) route its HTTP-01 validation
 *  connection to Loombre's real challenge listener. */
export async function registerAcmeDnsA(domain: string, ip: string): Promise<void> {
  const res = await fetch(`${CHALLTESTSRV_MANAGEMENT_URL}/add-a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: domain, addresses: [ip] }),
  });
  if (!res.ok) {
    throw new Error(`challtestsrv /add-a failed: ${res.status} ${await res.text()}`);
  }
}

export async function clearAcmeDnsA(domain: string): Promise<void> {
  const res = await fetch(`${CHALLTESTSRV_MANAGEMENT_URL}/clear-a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: domain }),
  });
  if (!res.ok) {
    throw new Error(`challtestsrv /clear-a failed: ${res.status} ${await res.text()}`);
  }
}
