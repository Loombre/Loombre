// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/shell/useLibraryShortcuts.ts
//
// Wave 1 (W1a) extraction: this was inline state in Sidebar.tsx (one
// GET /libraries + two useMemo finds for the Movies/TV Shows shortcut
// ids — see nav-items.ts's header for the ground truth on why those two
// are the only resolvable shortcuts). The mobile bottom tab bar and the
// mobile large-title header need the SAME two ids (Movies/TV Shows tabs
// reuse the sidebar's shortcuts; the header retitles to "Movies"/"TV Shows"
// when on the matching /browse?library= route) — lifting this into a hook
// called ONCE by ShellNav.tsx and threaded down as props keeps it to one
// network request per shell mount instead of three.

import { useEffect, useMemo, useState } from "react";
import type { components } from "@loombre/sdk";
import { apiGet } from "../../lib/api-client.js";

type Library = components["schemas"]["Library"];

export interface LibraryShortcuts {
  libraries: Library[] | null;
  /** First general-content-class library of mediaKind "movie", or null
   *  while GET /libraries hasn't resolved yet or none exists. */
  moviesLibraryId: string | null;
  tvLibraryId: string | null;
}

export function useLibraryShortcuts(): LibraryShortcuts {
  const [libraries, setLibraries] = useState<Library[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet("/libraries", { params: { query: { limit: 100 } } })
      .then((page) => {
        if (!cancelled) setLibraries(page.items);
      })
      .catch(() => {
        if (!cancelled) setLibraries([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const moviesLibraryId = useMemo(
    () => libraries?.find((l) => l.mediaKind === "movie" && l.contentClass === "general")?.id ?? null,
    [libraries],
  );
  const tvLibraryId = useMemo(
    () => libraries?.find((l) => l.mediaKind === "tv" && l.contentClass === "general")?.id ?? null,
    [libraries],
  );

  return { libraries, moviesLibraryId, tvLibraryId };
}
