// SPDX-License-Identifier: AGPL-3.0-only
export * from "./types.js";
export { parseMoviePath } from "./movie.js";
export { parseTvPath } from "./tv.js";
export { parseMusicPath } from "./music.js";
export { classifyAuxiliary } from "./auxiliary.js";
// Barrel-level re-export only (no rule/logic change to path-utils.ts
// itself): the scanner's per-library media-kind extension filter
// (../media-kind.ts) needs these sets and is meant to consume this API,
// not reach into parse/path-utils.ts directly.
export { VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, MEDIA_EXTENSIONS } from "./path-utils.js";
