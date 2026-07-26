#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: examples/lpp-reference-provider/server.mjs
//
// LPP v1 reference `metadata-provider` plugin (packages/plugin-protocol
// Lane W1 exit proof: "Both must pass their conformance suites"). Node
// stdlib only (node:http, node:crypto) — zero npm dependencies, by design:
// this demonstrates a real LPP plugin needs no Loombre-authored library,
// only an HTTP server that speaks the wire shapes documented in
// packages/plugin-protocol/spec/lpp-v1.md (C1 — plugins are separate HTTP
// services, any language/host). Every response shape below is hand-written
// to match that spec's schemas field-for-field; it does not import
// @loombre/plugin-protocol.
//
// Run directly: `node server.mjs` (reads PORT env, default 0 = ephemeral).
// Prints `LISTENING <port>` once bound — the integration test
// (packages/plugin-protocol/test/integration.spec.ts) spawns this exact
// file as a child process and parses that line to discover its port.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const MEDIA_KINDS = ["movie", "tv", "music"];
const ENTITY_KINDS = ["artist", "album", "track"];
// L-7 fix wave (adversarial review): the SAME cap the real Loombre host
// applies to what IT reads back from a plugin
// (packages/plugin-host/src/timeouts.ts's LPP_CAPABILITY_MAX_RESPONSE_BYTES)
// — a defensive bound against an unauthenticated request OOMing this
// process, independent of whether Loombre itself ever sends anything near
// this size. This is the dev-kit TEMPLATE every third-party plugin author
// copies from — the cap belongs here, not only in Loombre's own host code.
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

const MANIFEST = {
  name: "lpp-reference-provider",
  version: "0.1.0",
  protocolVersion: 1,
  capabilities: [
    {
      type: "metadata-provider",
      mediaKinds: MEDIA_KINDS,
      contentClass: "general",
      endpoints: {
        search: "/lpp/provider/search",
        details: "/lpp/provider/details",
        images: "/lpp/provider/images",
      },
    },
  ],
  configSchema: {
    type: "object",
    properties: {
      fixturePrefix: {
        type: "string",
        description: "Prefix prepended to every fake title this provider returns.",
        default: "Loombre Fixture",
      },
    },
    additionalProperties: false,
  },
  description: "Deterministic fake metadata for LPP v1 conformance testing and as an integration example.",
  publisher: "Loombre",
};

function problem(res, status, detail) {
  const body = {
    type: "urn:loombre:lpp:problem:validation",
    title: "Unprocessable Entity",
    status,
    detail,
  };
  res.writeHead(status, { "content-type": "application/problem+json" });
  res.end(JSON.stringify(body));
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** L-7 fix wave: caps the request body WHILE STREAMING it — the connection
 *  is destroyed the instant the cap is crossed, never after buffering an
 *  unbounded body. */
function readBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
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

function externalIdFor(title) {
  return createHash("sha1").update(title).digest("hex").slice(0, 12);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSearchRequest(body) {
  if (!isPlainObject(body)) return "request body must be a JSON object";
  if (!MEDIA_KINDS.includes(body.mediaKind)) return `mediaKind must be one of ${MEDIA_KINDS.join(", ")}`;
  if (typeof body.title !== "string" || body.title.length === 0) return "title must be a non-empty string";
  if (body.entityKind !== undefined && !ENTITY_KINDS.includes(body.entityKind)) {
    return `entityKind must be one of ${ENTITY_KINDS.join(", ")}`;
  }
  return null;
}

function refFor(body) {
  const ref = {
    provider: "lpp-reference-provider",
    externalId: externalIdFor(body.title),
    mediaKind: body.mediaKind,
  };
  if (body.mediaKind === "tv") {
    ref.seasonNumber = 1;
    ref.episodeNumber = 1;
  }
  if (body.mediaKind === "music") {
    ref.entityKind = body.entityKind ?? "artist";
  }
  return ref;
}

function handleSearch(body, res) {
  const error = validateSearchRequest(body);
  if (error) return problem(res, 422, error);
  const ref = refFor(body);
  json(res, 200, {
    results: [
      {
        ref,
        title: `${body.title} (Reference)`,
        year: body.year ?? 2001,
        overview: "Deterministic fixture result from the LPP reference provider.",
        popularity: 1,
      },
    ],
  });
}

function validateRef(ref) {
  if (!isPlainObject(ref)) return "ref must be a JSON object";
  if (typeof ref.provider !== "string" || ref.provider.length === 0) return "ref.provider must be a non-empty string";
  if (typeof ref.externalId !== "string" || ref.externalId.length === 0) return "ref.externalId must be a non-empty string";
  if (!MEDIA_KINDS.includes(ref.mediaKind)) return `ref.mediaKind must be one of ${MEDIA_KINDS.join(", ")}`;
  return null;
}

const PROVIDER_DETAILS_COMMON = (title) => ({
  title,
  sortTitle: title,
  year: 2001,
  overview: "Deterministic fixture details from the LPP reference provider.",
  communityRating: 7.5,
  contentRating: null,
  genres: ["Fixture"],
  tags: ["conformance"],
  people: [{ name: "Fixture Performer", role: "actor", order: 0, credit: "Self" }],
  providerIds: { "lpp-reference-provider": "fixture" },
});

function detailsFor(ref) {
  const title = `Fixture ${ref.externalId}`;
  const common = PROVIDER_DETAILS_COMMON(title);
  if (ref.mediaKind === "movie") {
    return { ...common, itemType: "movie", tagline: "A fixture tagline.", runtimeMs: 5_400_000 };
  }
  if (ref.mediaKind === "tv") {
    if (ref.episodeNumber !== undefined && ref.episodeNumber !== null) {
      return { ...common, itemType: "episode", seasonNumber: ref.seasonNumber ?? 1, episodeNumber: ref.episodeNumber, airDateMs: 978_307_200_000 };
    }
    if (ref.seasonNumber !== undefined && ref.seasonNumber !== null) {
      return { ...common, itemType: "season", seasonNumber: ref.seasonNumber };
    }
    return { ...common, itemType: "series", status: "ended", airDateMs: 978_307_200_000 };
  }
  // music
  if (ref.entityKind === "track") {
    return { ...common, itemType: "track", trackNumber: 1, discNumber: 1, durationMs: 210_000 };
  }
  if (ref.entityKind === "album") {
    return { ...common, itemType: "album" };
  }
  return { ...common, itemType: "artist" };
}

function handleDetails(body, res) {
  if (!isPlainObject(body)) return problem(res, 422, "request body must be a JSON object");
  const error = validateRef(body.ref);
  if (error) return problem(res, 422, error);
  json(res, 200, { details: detailsFor(body.ref) });
}

function handleImages(body, res) {
  if (!isPlainObject(body)) return problem(res, 422, "request body must be a JSON object");
  const error = validateRef(body.ref);
  if (error) return problem(res, 422, error);
  json(res, 200, {
    images: [
      { kind: "poster", url: `https://example.invalid/lpp-reference-provider/${body.ref.externalId}/poster.jpg`, width: 1000, height: 1500 },
      { kind: "backdrop", url: `https://example.invalid/lpp-reference-provider/${body.ref.externalId}/backdrop.jpg`, width: 1920, height: 1080 },
    ],
  });
}

const ROUTES = {
  "POST /lpp/provider/search": handleSearch,
  "POST /lpp/provider/details": handleDetails,
  "POST /lpp/provider/images": handleImages,
};

export function createReferenceProviderServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/lpp/manifest") {
      return json(res, 200, MANIFEST);
    }
    const routeKey = `${req.method} ${url.pathname}`;
    const handler = ROUTES[routeKey];
    if (!handler) {
      // L-7 fix wave: spec §5 requires RFC 9457 application/problem+json
      // for EVERY non-2xx response, 404 included — this was previously
      // plain application/json.
      res.writeHead(404, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ type: "about:blank", title: "Not Found", status: 404, detail: `no such route: ${routeKey}` }));
      return;
    }
    // L-7 fix wave: body-size cap enforced (readBody's own doc comment)
    // BEFORE any parsing/handler work — req.destroy() has already torn
    // down the connection on overflow, so there is nothing left to
    // respond to; only a genuine JSON-parse failure gets a 422.
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return;
    }
    let body;
    try {
      body = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
      return problem(res, 422, "request body must be valid JSON");
    }
    handler(body, res);
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 0);
  const server = createReferenceProviderServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log(`LISTENING ${typeof address === "object" && address ? address.port : port}`);
  });
}
