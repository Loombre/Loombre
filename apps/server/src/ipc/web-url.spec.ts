// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/web-url.spec.ts

import { describe, expect, it } from "vitest";
import { resolveWebUrl } from "./web-url.js";

describe("resolveWebUrl", () => {
  it("prefers LOOMBRE_WEB_URL when set", () => {
    expect(resolveWebUrl({ LOOMBRE_WEB_URL: "https://media.example.com" }, 3001, "off")).toBe(
      "https://media.example.com",
    );
  });

  it("trims LOOMBRE_WEB_URL", () => {
    expect(resolveWebUrl({ LOOMBRE_WEB_URL: "  https://media.example.com  " }, 3001, "off")).toBe(
      "https://media.example.com",
    );
  });

  it("ignores an empty/whitespace-only LOOMBRE_WEB_URL and falls back", () => {
    expect(resolveWebUrl({ LOOMBRE_WEB_URL: "   " }, 3001, "off")).toBe("http://localhost:3001");
  });

  it("falls back to http://localhost:<port> when tlsMode is off", () => {
    expect(resolveWebUrl({}, 3001, "off")).toBe("http://localhost:3001");
  });

  it("falls back to https://localhost:<port> when tlsMode is manual", () => {
    expect(resolveWebUrl({}, 443, "manual")).toBe("https://localhost:443");
  });

  it("falls back to https://localhost:<port> when tlsMode is acme", () => {
    expect(resolveWebUrl({}, 443, "acme")).toBe("https://localhost:443");
  });
});
