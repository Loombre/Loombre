// SPDX-License-Identifier: AGPL-3.0-only
/**
 * apps/worker/src/subtitles — segmented-VTT subtitle side-track extraction
 * (docs/PLAYBACK.md §9, STATE.md P3.9(e), Phase 3 §11 step 6b). Small and
 * deliberately alongside ../transcode, not inside it: a separate job type
 * ('subtitle-extract', packages/jobs) with its own consumer, reusing
 * ../transcode's staging/process primitives without modifying them. See
 * runner.ts's header for the full seam + the external-sidecar honesty
 * check this step's instructions required.
 */
export { createSubtitleExtractConsumerHandler } from "./consumer.js";
export { runSubtitleExtraction, SubtitleExtractionError, type RunSubtitleExtractionDeps } from "./runner.js";
export { renderSubtitlePlaylist } from "./playlist.js";
