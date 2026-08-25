// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/sections/library-path-label.test.ts
//
// browser-admin-F9. The component specs (UsersSection.test.tsx,
// CreateInviteSheet.test.tsx) prove the sub-line reaches the DOM; this
// file pins the formatting rules the two surfaces share.

import { describe, expect, it } from "vitest";
import { libraryNameWithPath, libraryPathLabel } from "./library-path-label.js";

describe("libraryPathLabel", () => {
  it("renders a single root as-is", () => {
    expect(libraryPathLabel(["/Users/ozzy/Desktop/Movies"])).toBe("/Users/ozzy/Desktop/Movies");
  });

  it("joins multiple roots with a comma so a multi-path library is still identifiable", () => {
    expect(libraryPathLabel(["/mnt/a", "/mnt/b"])).toBe("/mnt/a, /mnt/b");
  });

  it("returns null — not an empty string — when there is nothing to show", () => {
    expect(libraryPathLabel([])).toBeNull();
    expect(libraryPathLabel(["", "   "])).toBeNull();
    expect(libraryPathLabel(undefined)).toBeNull();
    expect(libraryPathLabel(null)).toBeNull();
  });

  it("drops blank entries but keeps the real ones", () => {
    expect(libraryPathLabel(["/mnt/a", "  ", "/mnt/b "])).toBe("/mnt/a, /mnt/b");
  });
});

// d3-d9: the single-string form, for aria-labels and dialog titles.
describe("libraryNameWithPath", () => {
  it("appends the path so two libraries with the same name read differently", () => {
    expect(libraryNameWithPath("Movies", ["/mnt/movies"])).toBe("Movies (/mnt/movies)");
    expect(libraryNameWithPath("Movies", ["/srv/media/movies"])).toBe("Movies (/srv/media/movies)");
  });

  it("joins multiple roots exactly as the sub-line formatter does", () => {
    expect(libraryNameWithPath("Movies", ["/mnt/a", "/mnt/b"])).toBe("Movies (/mnt/a, /mnt/b)");
  });

  it("falls back to the bare name rather than rendering an empty parenthesis", () => {
    expect(libraryNameWithPath("Movies", [])).toBe("Movies");
    expect(libraryNameWithPath("Movies", ["  "])).toBe("Movies");
    expect(libraryNameWithPath("Movies", undefined)).toBe("Movies");
  });
});
