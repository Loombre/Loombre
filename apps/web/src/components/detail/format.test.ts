// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  formatAudioMetaRow,
  formatAudioTrackLabel,
  formatChannelLayout,
  formatDirectorLabel,
  formatFileSize,
  formatLanguageLabel,
  formatRelativeAdded,
  formatResolution,
  formatSubtitlesMetaRow,
} from "./format.js";

describe("formatFileSize", () => {
  it("returns null for missing/zero/negative sizes", () => {
    expect(formatFileSize(null)).toBeNull();
    expect(formatFileSize(undefined)).toBeNull();
    expect(formatFileSize(0)).toBeNull();
    expect(formatFileSize(-5)).toBeNull();
  });

  it("formats bytes without a decimal", () => {
    expect(formatFileSize(512)).toBe("512 B");
  });

  it("formats larger sizes with one decimal once scaled below 10 units", () => {
    expect(formatFileSize(1_500_000_000)).toBe("1.4 GB");
  });

  it("formats mid-range sizes with no decimal", () => {
    expect(formatFileSize(15 * 1024 * 1024)).toBe("15 MB");
  });
});

describe("formatResolution", () => {
  it("returns null for missing/zero/negative height", () => {
    expect(formatResolution(null)).toBeNull();
    expect(formatResolution(undefined)).toBeNull();
    expect(formatResolution(0)).toBeNull();
  });

  it("appends 'p' to the height", () => {
    expect(formatResolution(1080)).toBe("1080p");
    expect(formatResolution(2160)).toBe("2160p");
  });
});

describe("formatChannelLayout", () => {
  it("returns null for missing/zero channel counts", () => {
    expect(formatChannelLayout(null)).toBeNull();
    expect(formatChannelLayout(undefined)).toBeNull();
    expect(formatChannelLayout(0)).toBeNull();
  });

  it("labels mono and stereo by name", () => {
    expect(formatChannelLayout(1)).toBe("MONO");
    expect(formatChannelLayout(2)).toBe("STEREO");
  });

  it("labels surround layouts as N.1", () => {
    expect(formatChannelLayout(6)).toBe("5.1");
    expect(formatChannelLayout(8)).toBe("7.1");
  });
});

describe("formatAudioTrackLabel", () => {
  it("joins codec and layout", () => {
    expect(formatAudioTrackLabel({ codec: "eac3", channels: 6 })).toBe("EAC3 5.1");
  });

  it("omits the layout when channels is null", () => {
    expect(formatAudioTrackLabel({ codec: "aac", channels: null })).toBe("AAC");
  });
});

describe("formatLanguageLabel", () => {
  it("uppercases a real language code", () => {
    expect(formatLanguageLabel("eng")).toBe("ENG");
  });

  it("falls back to UNKNOWN rather than guessing", () => {
    expect(formatLanguageLabel(null)).toBe("UNKNOWN");
    expect(formatLanguageLabel(undefined)).toBe("UNKNOWN");
  });
});

describe("formatRelativeAdded", () => {
  const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

  it("renders JUST NOW for sub-minute deltas", () => {
    expect(formatRelativeAdded(NOW - 30_000, NOW)).toBe("JUST NOW");
  });

  it("renders minutes, hours, and days", () => {
    expect(formatRelativeAdded(NOW - 5 * 60_000, NOW)).toBe("5M AGO");
    expect(formatRelativeAdded(NOW - 3 * 60 * 60_000, NOW)).toBe("3H AGO");
    expect(formatRelativeAdded(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe("2D AGO");
  });

  it("renders months and years for older items", () => {
    expect(formatRelativeAdded(NOW - 60 * 24 * 60 * 60_000, NOW)).toBe("2MO AGO");
    expect(formatRelativeAdded(NOW - 400 * 24 * 60 * 60_000, NOW)).toBe("1Y AGO");
  });

  it("clamps a future/clock-skewed timestamp to JUST NOW instead of going negative", () => {
    expect(formatRelativeAdded(NOW + 60_000, NOW)).toBe("JUST NOW");
  });
});

describe("formatDirectorLabel", () => {
  it("returns Unknown for no credits or no director role", () => {
    expect(formatDirectorLabel(null)).toBe("Unknown");
    expect(formatDirectorLabel([{ name: "Elena Marsh", role: "actor" }])).toBe("Unknown");
  });

  it("returns a single director's name", () => {
    expect(formatDirectorLabel([{ name: "Devon Kade", role: "director" }])).toBe("Devon Kade");
  });

  it("joins multiple directors", () => {
    expect(
      formatDirectorLabel([
        { name: "Devon Kade", role: "director" },
        { name: "Rhea Calloway", role: "director" },
        { name: "Elena Marsh", role: "actor" },
      ]),
    ).toBe("Devon Kade, Rhea Calloway");
  });
});

describe("formatAudioMetaRow", () => {
  it("returns 'Not probed' when there are no audio tracks", () => {
    expect(formatAudioMetaRow(null)).toBe("Not probed");
    expect(formatAudioMetaRow([])).toBe("Not probed");
  });

  it("joins codec+layout for every track", () => {
    expect(
      formatAudioMetaRow([
        { codec: "truehd", channels: 8, language: null },
        { codec: "ac3", channels: 6, language: null },
      ]),
    ).toBe("TRUEHD 7.1 · AC3 5.1");
  });

  it("appends distinct languages once, uppercased and slash-joined", () => {
    expect(
      formatAudioMetaRow([
        { codec: "truehd", channels: 8, language: "eng" },
        { codec: "ac3", channels: 6, language: "spa" },
        { codec: "aac", channels: 2, language: "eng" },
      ]),
    ).toBe("TRUEHD 7.1 · AC3 5.1 · AAC STEREO · ENG/SPA");
  });
});

describe("formatSubtitlesMetaRow", () => {
  it("returns 'None' when there are no subtitle tracks", () => {
    expect(formatSubtitlesMetaRow(null)).toBe("None");
    expect(formatSubtitlesMetaRow([])).toBe("None");
  });

  it("uppercases languages and marks forced tracks", () => {
    expect(
      formatSubtitlesMetaRow([
        { language: "eng", isForced: false },
        { language: "eng", isForced: true },
        { language: null, isForced: false },
      ]),
    ).toBe("ENG · ENG (FORCED) · UNKNOWN");
  });
});
