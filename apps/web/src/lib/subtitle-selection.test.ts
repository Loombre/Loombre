// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/subtitle-selection.test.ts

import { describe, expect, it } from "vitest";
import {
  decideSubtitleSelection,
  isSubtitleTrackShown,
} from "./subtitle-selection.js";

const vtt3 = { subtitle: { strategy: "hls-vtt", streamIndex: 3 } };
const none = { subtitle: { strategy: "none" } };

describe("decideSubtitleSelection", () => {
  it("Off is a client-side hide — never a new session", () => {
    expect(decideSubtitleSelection(vtt3, null)).toEqual({ kind: "hide" });
    expect(decideSubtitleSelection(none, null)).toEqual({ kind: "hide" });
    expect(decideSubtitleSelection(null, null)).toEqual({ kind: "hide" });
  });

  it("re-selecting the stream this session already extracted just shows it again", () => {
    expect(decideSubtitleSelection(vtt3, 3)).toEqual({ kind: "show" });
  });

  it("any other stream needs a new session pinned to it", () => {
    expect(decideSubtitleSelection(vtt3, 4)).toEqual({
      kind: "recreate",
      subtitleStreamIndex: 4,
    });
    expect(decideSubtitleSelection(none, 3)).toEqual({
      kind: "recreate",
      subtitleStreamIndex: 3,
    });
    expect(decideSubtitleSelection(null, 3)).toEqual({
      kind: "recreate",
      subtitleStreamIndex: 3,
    });
  });
});

describe("isSubtitleTrackShown", () => {
  it("is true only when the selection names the stream the session's side-track carries", () => {
    expect(isSubtitleTrackShown(3, vtt3)).toBe(true);
    expect(isSubtitleTrackShown(4, vtt3)).toBe(false);
    expect(isSubtitleTrackShown(null, vtt3)).toBe(false);
    expect(isSubtitleTrackShown(3, none)).toBe(false);
    expect(isSubtitleTrackShown(3, null)).toBe(false);
  });
});
