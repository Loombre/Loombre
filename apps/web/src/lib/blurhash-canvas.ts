// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/blurhash-canvas.ts
//
// Decodes a blurhash string to a tiny canvas and reads it back out as a
// data: URI — used as the LQIP `<img>` src that crossfades to the real
// image once it loads (P2.10: never a pop-in). Deliberately tiny (32x32
// decode) since this only ever gets blurred/upscaled by CSS.

import { decode } from "blurhash";

const DECODE_SIZE = 32;

export function blurhashToDataUri(hash: string): string | null {
  if (typeof document === "undefined") return null;
  try {
    const pixels = decode(hash, DECODE_SIZE, DECODE_SIZE);
    const canvas = document.createElement("canvas");
    canvas.width = DECODE_SIZE;
    canvas.height = DECODE_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const imageData = ctx.createImageData(DECODE_SIZE, DECODE_SIZE);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
