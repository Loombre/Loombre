#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: examples/lpp-discord-notifier/server.mjs
//
// LPP v1 reference `event-subscriber` plugin (packages/plugin-protocol
// Lane W1 exit proof). Node stdlib only (node:http, node:https,
// node:crypto) — zero npm dependencies, and no dependency on
// @loombre/plugin-protocol either: the signature verification below is a
// hand-rolled, independent implementation of the scheme documented in
// packages/plugin-protocol/spec/lpp-v1.md §4.2, proving that spec is
// implementable by a real third party with nothing but the document.
//
// Config: one secret field, `webhookUrl` (configSchema — see MANIFEST
// below), delivered per request via `X-LPP-Secret-WEBHOOKURL` (headers.ts's
// canonicalization of the field key "webhookUrl"). The delivery-signing
// secret is a SEPARATE concern (spec §4.2's design decision: provisioned
// out-of-band, not re-delivered per request) — this plugin reads it once at
// startup from LOOMBRE_LPP_SIGNING_SECRET.
//
// Run directly: `node server.mjs` (reads PORT, default 0 = ephemeral, and
// requires LOOMBRE_LPP_SIGNING_SECRET). Prints `LISTENING <port>` once
// bound, same convention as examples/lpp-reference-provider/server.mjs.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";

const REPLAY_WINDOW_MS = 5 * 60_000;
// L-7 fix wave (adversarial review): the SAME cap the real Loombre host
// applies to what IT reads back from a plugin
// (packages/plugin-host/src/timeouts.ts's LPP_CAPABILITY_MAX_RESPONSE_BYTES)
// — no legitimate delivery batch from a real host ever approaches this, so
// this is purely a defensive bound against an unauthenticated
// POST /lpp/events from anyone else on the network OOMing this process
// before signature verification even runs. This is the dev-kit TEMPLATE
// every third-party plugin author copies from — the cap belongs here, not
// only in Loombre's own host code.
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

const MANIFEST = {
  name: "lpp-discord-notifier",
  version: "0.1.0",
  protocolVersion: 1,
  capabilities: [
    {
      type: "event-subscriber",
      eventTypes: ["item.added", "playback.started"],
      delivery: { endpoint: "/lpp/events" },
      contentClass: "general",
    },
  ],
  configSchema: {
    type: "object",
    properties: {
      webhookUrl: {
        type: "string",
        description: "Webhook URL every delivered event is forwarded to as a formatted message.",
        secret: true,
      },
    },
    required: ["webhookUrl"],
    additionalProperties: false,
  },
  description: "Forwards Loombre outbox events to a configured webhook URL as formatted messages.",
  publisher: "Loombre",
};

function problem(res, status, type, title, detail) {
  res.writeHead(status, { "content-type": "application/problem+json" });
  res.end(JSON.stringify({ type, title, status, detail }));
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** L-7 fix wave: caps the request body WHILE STREAMING it — the connection
 *  is destroyed the instant the cap is crossed, never after buffering an
 *  unbounded body — and rejects, so the caller can bail out BEFORE doing
 *  any further work (signature verification included) on a body that was
 *  never going to be legitimate anyway. */
function readRawBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let destroyed = false;
    req.on("data", (chunk) => {
      if (destroyed) return;
      total += chunk.length;
      if (total > maxBytes) {
        destroyed = true;
        req.destroy();
        reject(new Error(`request body exceeded the ${maxBytes}-byte cap`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!destroyed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!destroyed) reject(err);
    });
  });
}

function parseSignatureHeader(headerValue) {
  if (!headerValue) return null;
  const parts = new Map();
  for (const segment of headerValue.split(",")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    parts.set(segment.slice(0, eq).trim(), segment.slice(eq + 1).trim());
  }
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isFinite(t) || !v1 || !/^[0-9a-fA-F]+$/.test(v1)) return null;
  return { timestampMs: t, signatureHex: v1.toLowerCase() };
}

function verifySignature(headerValue, secret, rawBody, nowMs) {
  const parsed = parseSignatureHeader(headerValue);
  if (!parsed) return { valid: false, reason: "malformed-header" };
  const expectedHex = createHmac("sha256", secret).update(`${parsed.timestampMs}.${rawBody}`, "utf8").digest("hex");
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(parsed.signatureHex, "hex");
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!matches) return { valid: false, reason: "signature-mismatch" };
  if (Math.abs(nowMs - parsed.timestampMs) > REPLAY_WINDOW_MS) return { valid: false, reason: "stale-timestamp" };
  return { valid: true };
}

function decodeSecretHeader(value) {
  return Buffer.from(value, "base64").toString("utf8");
}

function formatMessage(event) {
  return `[Loombre] ${event.type} at ${new Date(event.occurredAtMs).toISOString()}: ${JSON.stringify(event.payload)}`;
}

function postJsonTo(targetUrl, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      return reject(err);
    }
    const impl = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const payload = JSON.stringify(body);
    const req = impl(
      parsed,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function handleEvents(req, res, signingSecret) {
  let rawBody;
  try {
    // L-7 fix wave: body-size cap enforced BEFORE signature verification —
    // an unauthenticated POST here must never be able to OOM this process
    // regardless of whether it ever had a valid signature at all.
    rawBody = await readRawBody(req);
  } catch {
    // req.destroy() has already torn down the connection (readRawBody's
    // own doc comment) — nothing left to respond to.
    return;
  }
  const signatureHeader = req.headers["x-lpp-signature"];
  const verification = verifySignature(
    Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader,
    signingSecret,
    rawBody,
    Date.now(),
  );
  if (!verification.valid) {
    const status = verification.reason === "stale-timestamp" ? 401 : 401;
    const type =
      verification.reason === "stale-timestamp"
        ? "urn:loombre:lpp:problem:stale-timestamp"
        : "urn:loombre:lpp:problem:invalid-signature";
    return problem(res, status, type, "Unauthorized", `signature verification failed: ${verification.reason}`);
  }

  let batch;
  try {
    batch = JSON.parse(rawBody);
  } catch {
    return problem(res, 422, "urn:loombre:lpp:problem:validation", "Unprocessable Entity", "request body must be valid JSON");
  }

  const webhookHeader = req.headers["x-lpp-secret-webhookurl"];
  const webhookUrl = webhookHeader ? decodeSecretHeader(Array.isArray(webhookHeader) ? webhookHeader[0] : webhookHeader) : undefined;

  let forwarded = 0;
  if (webhookUrl) {
    for (const event of batch.events ?? []) {
      try {
        await postJsonTo(webhookUrl, { content: formatMessage(event) });
        forwarded++;
      } catch (err) {
        console.error(`lpp-discord-notifier: forward failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  json(res, 200, { acked: batch.batchId, forwarded });
}

export function createDiscordNotifierServer(signingSecret) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/lpp/manifest") {
      return json(res, 200, MANIFEST);
    }
    if (req.method === "POST" && url.pathname === "/lpp/events") {
      return handleEvents(req, res, signingSecret);
    }
    // L-7 fix wave: spec §5 requires RFC 9457 application/problem+json for
    // EVERY non-2xx response, 404 included — this was previously plain
    // application/json.
    return problem(res, 404, "about:blank", "Not Found", `no such route: ${req.method} ${url.pathname}`);
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const signingSecret = process.env.LOOMBRE_LPP_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("lpp-discord-notifier: LOOMBRE_LPP_SIGNING_SECRET is required");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 0);
  const server = createDiscordNotifierServer(signingSecret);
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log(`LISTENING ${typeof address === "object" && address ? address.port : port}`);
  });
}
