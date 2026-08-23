// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/auth-return-path.test.ts
//
// browser-shell-browse-F1: the pure half of the auth-loss redirect —
// AppShell.test.tsx covers the rendered behaviour, this file covers the
// string rules underneath it, including the open-redirect refusals (the
// `?next=` value is attacker-supplied by construction: anyone can send a
// link to /login?next=…).

import { describe, expect, it } from "vitest";
import {
  buildLoginHref,
  currentLocationPath,
  readReturnPathFromLocation,
  readReturnPathFromSearch,
  sanitizeReturnPath,
} from "./auth-return-path.js";

describe("sanitizeReturnPath — accepts in-app paths", () => {
  it("keeps a plain path", () => {
    expect(sanitizeReturnPath("/browse")).toBe("/browse");
  });

  it("keeps a path with a query string and percent-encoding", () => {
    expect(sanitizeReturnPath("/browse?library=abc&sort=name%20asc")).toBe("/browse?library=abc&sort=name%20asc");
  });

  it("keeps a deep item path with a fragment", () => {
    expect(sanitizeReturnPath("/items/movie/01a0#cast")).toBe("/items/movie/01a0#cast");
  });
});

describe("sanitizeReturnPath — refuses anything that could leave this origin", () => {
  const rejected: Array<[string, string | null | undefined]> = [
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["absolute http URL", "http://evil.example.com/"],
    ["absolute https URL", "https://evil.example.com/"],
    ["javascript: URL", "javascript:alert(1)"],
    ["data: URL", "data:text/html,<script>1</script>"],
    ["scheme-relative host", "//evil.example.com/"],
    ["backslash host", "/\\evil.example.com/"],
    ["embedded backslash", "/browse\\..\\evil"],
    ["relative path", "browse"],
    ["tab-smuggled host", "/\t/evil.example.com"],
    ["newline-smuggled host", "/\n/evil.example.com"],
    ["raw space", "/browse?q=my movie"],
    ["over-long", `/${"a".repeat(600)}`],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(sanitizeReturnPath(value)).toBeNull();
    });
  }
});

describe("sanitizeReturnPath — refuses auth entry points (no sign-in loops)", () => {
  for (const path of ["/login", "/login?next=%2Fbrowse", "/setup", "/setup/step2", "/forgot", "/reset/abc", "/claim/xyz"]) {
    it(`rejects ${path}`, () => {
      expect(sanitizeReturnPath(path)).toBeNull();
    });
  }

  it("does not reject a real route that merely starts with the same letters", () => {
    expect(sanitizeReturnPath("/settings/libraries")).toBe("/settings/libraries");
    expect(sanitizeReturnPath("/logins-report")).toBe("/logins-report");
  });
});

describe("buildLoginHref", () => {
  it("encodes the return path into ?next=", () => {
    expect(buildLoginHref("/browse?library=abc")).toBe("/login?next=%2Fbrowse%3Flibrary%3Dabc");
  });

  it("falls back to a bare /login for an unusable current path", () => {
    expect(buildLoginHref(null)).toBe("/login");
    expect(buildLoginHref("//evil.example.com")).toBe("/login");
    expect(buildLoginHref("/login")).toBe("/login");
  });

  it("round-trips through readReturnPathFromSearch", () => {
    const href = buildLoginHref("/browse?library=abc&page=2");
    const search = href.slice(href.indexOf("?"));
    expect(readReturnPathFromSearch(search)).toBe("/browse?library=abc&page=2");
  });
});

describe("readReturnPathFromSearch", () => {
  it("returns null when there is no next parameter", () => {
    expect(readReturnPathFromSearch("")).toBeNull();
    expect(readReturnPathFromSearch("?other=1")).toBeNull();
  });

  it("sanitizes what it finds", () => {
    expect(readReturnPathFromSearch("?next=https%3A%2F%2Fevil.example.com")).toBeNull();
    expect(readReturnPathFromSearch("?next=%2F%2Fevil.example.com")).toBeNull();
    expect(readReturnPathFromSearch("?next=%2Fwatchlist")).toBe("/watchlist");
  });
});

describe("location readers (jsdom)", () => {
  it("reports path + query and reads ?next= from the live URL", () => {
    window.history.replaceState({}, "", "/browse?next=%2Fwatchlist&library=abc");
    expect(currentLocationPath()).toBe("/browse?next=%2Fwatchlist&library=abc");
    expect(readReturnPathFromLocation()).toBe("/watchlist");
    window.history.replaceState({}, "", "/");
    expect(readReturnPathFromLocation()).toBeNull();
  });
});
