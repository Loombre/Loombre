// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/ui/QrCode.tsx
//
// STATE.md "Loombre Remote ..." (RG8, Lane U2): the reusable QR-code
// primitive the wizard's enrollment ceremony (R2/R3) and reachability
// proof (R6) both render. RG8's own adjudication: "no QR lib exists
// anywhere. Client-side rendering in the web app with a small
// MIT-licensed encoder... Remote-enrollment QR encodes the full wg-quick
// config text... probe QR encodes only the URL."
//
// LIBRARY CHOICE (RG8: "evaluate qrcode (soldair) vs qr-creator/similar:
// pick maintained + MIT + small"): `qrcode` (npm `qrcode`, soldair/
// node-qrcode) — MIT, actively maintained (5M+ weekly downloads, last
// published 2025-11-13), zero problematic browser deps. The alternative
// evaluated, `qr-creator`, is also MIT but last published 2022 (3 years
// stale) — fails RG8's "maintained" criterion. `qrcode`'s package.json
// declares `pngjs`/`yargs`/`dijkstrajs` as dependencies, but those back
// ONLY its Node/CLI entry point (`lib/index.js` -> `lib/server.js`); its
// `browser` field remaps `./lib/index.js` to `./lib/browser.js`, which
// requires just `./core/qrcode` (the pure encoder) + `./renderer/canvas` +
// `./renderer/svg-tag` — no Node built-ins, no pngjs/yargs/dijkstrajs in
// the bundle a browser bundler (webpack, via next build --webpack)
// actually ships. Verified: apps/web's license-check passed with the full
// dependency tree (qrcode + its Node-only deps) added — every license is
// on the allow-list even though most of that tree never reaches the
// browser bundle.
//
// This component does NOT call `qrcode`'s own toString()/toCanvas()
// renderers (those are async-callback-shaped for Node parity, awkward for
// a synchronous React render). Instead it uses the package's synchronous,
// pure `create(value, opts)` — which returns the raw QR module matrix
// (`QRCode.modules`, a BitMatrix) with NO async/callback anywhere — and
// renders the SVG itself, adapting the exact path-building algorithm
// `qrcode`'s own `lib/renderer/svg-tag.js` uses (a single `<path>` of
// horizontal run-length `h` commands per dark row-run, not one `<rect>`
// per module — avoids emitting thousands of DOM nodes for a large QR).
//
// Admin-only bundle scope (RG8/mission item 1: "Keep it inside admin
// route chunks"): this component is imported only from
// components/settings/remote-wizard/* (mounted at /settings/remote-access,
// an admin-only route never reached from /browse's own route tree) — Next
// App Router's per-route code splitting keeps it out of /browse's bundle
// by construction; verified against a real `next build --webpack` (see
// this lane's freeze report for the exact chunk list), no `next/dynamic`
// wrapper needed on top of that (BootSplashLazy's own case is different:
// that component mounts on EVERY route via AppShell, which /browse's tree
// DOES include, so it needs an explicit dynamic() split — QrCode never
// sits on that shared path at all).

import { create } from "qrcode";
import styles from "./QrCode.module.css";

export interface QrCodeProps {
  /** The exact payload to encode — a WG config's full text, a probe URL,
   *  anything. Empty string renders the honest empty-state instead of
   *  throwing (qrcode's own `create()` throws on empty input). */
  value: string;
  /** Rendered pixel size (square). Default matches the wizard's QR slots. */
  size?: number;
  /** Accessible label — the QR encodes machine-readable data a screen
   *  reader cannot usefully announce, so callers should say what scanning
   *  it does ("QR code for this device's WireGuard configuration"). */
  label: string;
  className?: string;
}

const DEFAULT_SIZE = 220;
/** Matches `qrcode`'s own renderer default margin (4 modules) — enough
 *  quiet zone for real-world scanners; the ISO spec's own minimum. */
const QUIET_ZONE_MODULES = 4;

/** Adapts qrcode/lib/renderer/svg-tag.js's `qrToPath` — same run-length
 *  horizontal-line algorithm, credited above. Builds ONE `<path>` `d`
 *  string covering every dark module as a series of `M`/`h` segments
 *  (one moveto per row-run, then a horizontal line for its length) rather
 *  than one `<rect>` per module. */
function buildModulePath(data: Uint8Array, size: number, margin: number): string {
  let path = "";
  let moveBy = 0;
  let newRow = false;
  let lineLength = 0;

  for (let i = 0; i < data.length; i++) {
    const col = i % size;
    const row = Math.floor(i / size);

    if (col === 0 && !newRow) newRow = true;

    if (data[i]) {
      lineLength++;
      if (!(i > 0 && col > 0 && data[i - 1])) {
        path += newRow ? `M${col + margin} ${0.5 + row + margin}` : `m${moveBy} 0`;
        moveBy = 0;
        newRow = false;
      }
      if (!(col + 1 < size && data[i + 1])) {
        path += `h${lineLength}`;
        lineLength = 0;
      }
    } else {
      moveBy++;
    }
  }

  return path;
}

export function QrCode({ value, size = DEFAULT_SIZE, label, className }: QrCodeProps): React.JSX.Element {
  if (value.length === 0) {
    return (
      <div
        className={[styles.empty, className].filter(Boolean).join(" ")}
        style={{ width: size, height: size }}
        role="img"
        aria-label="No QR code available"
      >
        <span>No data to encode yet</span>
      </div>
    );
  }

  const qr = create(value, { errorCorrectionLevel: "M" });
  const moduleCount = qr.modules.size;
  const gridSize = moduleCount + QUIET_ZONE_MODULES * 2;
  const d = buildModulePath(qr.modules.data, moduleCount, QUIET_ZONE_MODULES);

  return (
    <svg
      className={[styles.qr, className].filter(Boolean).join(" ")}
      width={size}
      height={size}
      viewBox={`0 0 ${gridSize} ${gridSize}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect x={0} y={0} width={gridSize} height={gridSize} fill="#ffffff" />
      <path d={d} stroke="#000000" fill="none" />
    </svg>
  );
}
