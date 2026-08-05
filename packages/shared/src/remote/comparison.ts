// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/remote/comparison.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R8's "honest comparison card", Batch-1
// lane U1). Single source of the three-path comparison content across the
// R8 axes (attack surface, third parties, difficulty, what-breaks-when).
//
// Cross-lane seam (STATE.md "Orchestrator freeze ground-truth + Batch-1
// dispatch": "Comparison-card ... CONTENT live in packages/shared/src/
// remote/ as single-source data modules (U1 authors comparison ...) ...
// DOC consumes the same source per R10."). U1's RecommendationStage/
// ComparisonTable render this; the ops docs' remote-access landing page
// (R10's decision-tree + comparison table) sources the SAME PATH_COMPARISON
// below rather than hand-copying values that could drift out of sync.
//
// Content is plain-language and sourced from this run's own locked truths
// (STATE.md R1-R9), never marketing copy — the whole point of an "honest"
// comparison card is that a worse-sounding fact for a given path stays a
// worse-sounding fact:
//   - Remote (embedded WireGuard, R1-R3): silent to internet scanners
//     (verified by test — an unrecognized packet gets no response at all),
//     but needs a small app installed per device and one UDP port forwarded
//     on the router.
//   - Tunnel (BYO Cloudflare, R4): no inbound ports at all, but Cloudflare
//     sits in the request path for every connection — a real third-party
//     dependency, stated plainly rather than glossed over (R4/R9).
//   - Direct (R5): the most exposed of the three (a real public HTTPS
//     port) and the most router work (manual port-forwarding), but the one
//     most likely to "just work" as an ordinary shareable URL once set up.

import type { PathId } from "./wizard-state.js";

/** The R8 axes, literal: "attack surface, third parties, difficulty,
 *  what-breaks-when". Closed set — a new axis is a design decision, not
 *  something a caller can add ad hoc. */
export const COMPARISON_AXES = ["attackSurface", "thirdParties", "difficulty", "whatBreaksWhen"] as const;

export type ComparisonAxis = (typeof COMPARISON_AXES)[number];

/** Human-facing column/row headers for each axis. */
export const COMPARISON_AXIS_LABELS: Record<ComparisonAxis, string> = {
  attackSurface: "Attack surface",
  thirdParties: "Third parties",
  difficulty: "Setup difficulty",
  whatBreaksWhen: "What breaks, and when",
};

/** The comparison card's actual content — one non-empty plain-language cell
 *  per (path, axis). Every cell is a complete sentence or two: this is the
 *  ONLY copy of this content anywhere in the app (see module header) — a
 *  UI component or docs page that needs comparison text reads it from
 *  here, never re-typed at the call site. */
export const PATH_COMPARISON: Record<PathId, Record<ComparisonAxis, string>> = {
  remote: {
    attackSurface:
      "Silent to internet scanners. The WireGuard listener answers only a recognized device's own key — an unauthenticated probe gets no response at all, not even a rejection (verified by test).",
    thirdParties: "None. The tunnel terminates entirely inside Loombre — no outside service ever sees your traffic.",
    difficulty:
      "Install the WireGuard app on every device that needs access and scan a QR code once per device. Requires forwarding one UDP port on your router.",
    whatBreaksWhen:
      "Devices already enrolled keep working through most router or ISP address changes (WireGuard reconnects on its own). Replacing your router can require re-forwarding the port.",
  },
  tunnel: {
    attackSurface: "No inbound ports opened on your router at all — the connection to Cloudflare is outbound-only.",
    thirdParties:
      "Cloudflare sits in the path for every connection — a real third-party dependency, not something this path can avoid (stated plainly, not glossed over).",
    difficulty:
      "Paste a scoped Cloudflare API token once. Loombre creates the tunnel and DNS route for you and runs a small connector process it supervises and restarts automatically.",
    whatBreaksWhen:
      "If the connector process or Cloudflare itself has an outage, remote access pauses until it recovers — your library keeps working normally on your own network the whole time.",
  },
  direct: {
    attackSurface:
      "The most exposed of the three: your server's HTTPS port is reachable by anyone on the public internet who finds the address (rate-limited, but reachable).",
    thirdParties:
      "None beyond the certificate authority issuing your TLS certificate — no traffic passes through anyone else's servers.",
    difficulty:
      "Needs a real TLS certificate (Loombre can obtain one for you automatically) and manually forwarding a port on your router — the most router work of the three paths.",
    whatBreaksWhen:
      "An ISP address change or a missed certificate renewal breaks access until you update DNS/port-forwarding or renew — but once set up, it is the option most likely to 'just work' as an ordinary shareable URL.",
  },
};

export interface ComparisonRow {
  axis: ComparisonAxis;
  label: string;
  values: Record<PathId, string>;
}

/** Comparison content reshaped as one row per axis (a table-friendly view
 *  over PATH_COMPARISON) — the shape ComparisonTable.tsx and the docs
 *  generator both want, derived rather than duplicated. */
export function comparisonRows(): readonly ComparisonRow[] {
  return COMPARISON_AXES.map((axis) => ({
    axis,
    label: COMPARISON_AXIS_LABELS[axis],
    values: {
      remote: PATH_COMPARISON.remote[axis],
      tunnel: PATH_COMPARISON.tunnel[axis],
      direct: PATH_COMPARISON.direct[axis],
    },
  }));
}
