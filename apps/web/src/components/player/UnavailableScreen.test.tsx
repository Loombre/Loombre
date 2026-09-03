// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/player/UnavailableScreen.test.tsx
//
// Phosphor W2 lane L5 exit-gate proof ("build the refusal rendering
// against REAL engine output"): this feeds the actual, pure
// `@loombre/playback-engine` `plan()` — no mock, no hand-typed reasons — a
// PlanInput whose `media` mirrors the SEEDED 2160p movie file byte-for-
// byte (packages/db/seed/seed.mjs's `media_streams` insert: hevc, 3840x2160,
// 10-bit, color_transfer smpte2084 -> hdr:'hdr10' per apps/worker/src/probe/
// extract.ts's real derivation; eac3 6ch 640kbps audio) and a capability
// profile engineered to genuinely refuse it (HEVC main10 decode confirmed,
// but no HDR10/HLG/DV flag — exactly what lib/device-profile.ts's real
// browser probing produces for a 10-bit-capable decoder on a non-HDR
// display; T0-default policy + software-only caps — both lifted verbatim
// from packages/playback-engine/matrix/fixtures/{policies,caps}.yaml, the
// SAME fixture pairing matrix case 144 proves refuses tone-mapping). The
// resulting REAL `PlaybackPlan.reasons` are then handed to
// `<UnavailableScreen>` and the render is asserted against THAT array —
// never a hand-authored one — so a future engine change that alters the
// reason set is caught here, not silently drifted past.
//
// A second `plan()` call, same device/network/policy/caps, media swapped
// for a plausible 1080p h264 SDR alternate (constructed — no real seeded
// item has a second media_files row today, see lib/playback-fallback.ts's
// header for that ground-truth finding), proves the OTHER half of the
// fallback predicate (`isPlanRefused`) against real engine output too: the
// same device that refuses the 2160p HDR file does NOT refuse this one.

import { afterEach, describe, expect, it, vi } from "vitest";
import { plan } from "@loombre/playback-engine";
import type { DeviceProfile, MediaInfo, NetworkConditions, ServerPolicy, TrackSelection, VerifiedCapabilities } from "@loombre/playback-engine";
import { describeReasonCode } from "../../lib/playback-reasons.js";
import { SESSION_FAILED_CODE, sessionFailureReasons } from "../../lib/playback-recovery.js";
import { isPlanRefused } from "../../lib/playback-fallback.js";
import { UnavailableScreen } from "./UnavailableScreen.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

type Listener = (event: { matches: boolean }) => void;

function installMatchMedia(initialMatches: boolean): void {
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: initialMatches,
      media: query,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => true,
    })),
  );
}

// ── Real capability profile: HEVC main10 decode confirmed, no HDR flag ──
// packages/playback-engine/matrix/fixtures/devices.yaml's `hevc-sdr` video
// entry, PLUS `web-chrome`'s h264 entry (same file) — a single real browser
// commonly supports both (device-profile.ts probes h264 and hevc
// independently), which is what makes the SDR alternate below genuinely
// playable on this SAME device while the HDR file is genuinely refused.
const device: DeviceProfile = {
  profileId: "test-hevc10-decode-no-hdr-display",
  directPlayContainers: ["mp4"],
  hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
  video: [
    { codec: "hevc", maxProfile: "main10", maxLevel: 153, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: 80_000_000 },
    { codec: "h264", maxProfile: "high", maxLevel: 52, maxBitDepth: 8, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: 50_000_000 },
  ],
  hdr: { hdr10: false, hlg: false, dolbyVision: false },
  audio: [{ codec: "aac", maxChannels: 6, passthrough: false }],
  subtitles: { renderText: [], hlsVtt: false, renderImage: false },
  maxStreamBitrateBps: null,
};

// lib/network-conditions.ts's own generous placeholder default (no real
// bandwidth probe exists), local network.
const network: NetworkConditions = { maxBitrateBps: 200_000_000, isLocal: true };

// packages/playback-engine/matrix/fixtures/policies.yaml's `t0-default`,
// verbatim (the instance default ladder table, docs/PLAYBACK.md §7).
const policy: ServerPolicy = {
  allowTranscode: true,
  allowToneMapCpu: "tier-gated",
  tier: 0,
  preferredTextSubMode: "hls-vtt",
  preserveAssStyling: false,
  audioTranscodeCodecPriority: ["opus", "aac"],
  maxSimultaneousTranscodes: 1,
  ladderRungs: [
    { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
    { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "h264" },
    { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
    { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
    { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
    { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
  ],
  segmentDurationSec: 2,
  hevcEncodePreferred: false,
  av1EncodePreferred: false,
};

// packages/playback-engine/matrix/fixtures/caps.yaml's `software-only`,
// verbatim — no backend has a non-empty toneMap array, so Stage G can
// never route a hardware tone-map for the HDR file below.
const caps: VerifiedCapabilities = {
  backends: [{ backend: "software", decode: ["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1_750_000_000_000 }],
};

const selection: TrackSelection = { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null };

// packages/db/seed/seed.mjs's real seeded movie file, field-for-field: mkv
// container, hevc 3840x2160 10-bit `color_transfer: smpte2084` (-> hdr10
// per apps/worker/src/probe/extract.ts), 18 Mbps, 23.976fps; eac3 6ch
// 640kbps 48kHz `is_default: true`. durationMs/sizeBytes are the seed's own
// 108-minute/6.4GB values; overallBitrateBps is size/duration derived
// (docs/PLAYBACK.md §2.1 — "derived if probe lacks it"), same as the real
// server would compute.
const seededMovie2160pHdr: MediaInfo = {
  fileId: "seed-movie-2160p-hevc10-hdr10",
  container: "mkv",
  durationMs: 6_480_000,
  sizeBytes: 6_400_000_000,
  overallBitrateBps: 7_901_235,
  video: [
    { index: 0, codec: "hevc", profile: null, level: null, width: 3840, height: 2160, bitDepth: 10, frameRate: 23.976, bitrateBps: 18_000_000, hdr: "hdr10", dvProfile: null, dvBlCompatId: null, interlaced: false, openGop: false },
  ],
  audio: [{ index: 1, codec: "eac3", channels: 6, sampleRate: 48_000, bitrateBps: 640_000, language: "eng", isDefault: true, hasAtmos: false }],
  subtitle: [],
};

// A PLAUSIBLE alternate version (constructed — no real seeded item has a
// second media_files row today; see lib/playback-fallback.ts's header for
// that ground-truth finding), same runtime, ordinary web-delivery shape:
// mp4/h264/8-bit/SDR, stereo aac.
const alternate1080pSdr: MediaInfo = {
  fileId: "constructed-alt-1080p-h264-sdr",
  container: "mp4",
  durationMs: 6_480_000,
  sizeBytes: 3_000_000_000,
  overallBitrateBps: 3_703_704,
  video: [
    { index: 0, codec: "h264", profile: "high", level: 40, width: 1920, height: 1080, bitDepth: 8, frameRate: 23.976, bitrateBps: 8_000_000, hdr: "none", dvProfile: null, dvBlCompatId: null, interlaced: false, openGop: false },
  ],
  audio: [{ index: 1, codec: "aac", channels: 2, sampleRate: 48_000, bitrateBps: 192_000, language: "eng", isDefault: true, hasAtmos: false }],
  subtitle: [],
};

describe("the real playback-engine's own refusal (ground truth for the tests below)", () => {
  it("genuinely refuses the seeded 2160p HEVC10 HDR10 file on a confirmed-non-HDR device (T0 + software-only)", () => {
    const result = plan({ media: seededMovie2160pHdr, device, network, policy, caps, selection, mode: "stream" });
    expect(result.decision).toBe("transcode");
    expect(result.ffmpegArgs).toEqual([]);
    expect(result.ladder).toEqual([]);
    const codes = result.reasons.map((r) => r.code);
    expect(codes).toContain("hdr-tone-map-required");
    expect(codes).toContain("tone-map-refused-by-policy");
    expect(isPlanRefused(result)).toBe(true);
  });

  it("does NOT refuse a plausible 1080p h264 SDR alternate on the SAME device/network/policy/caps", () => {
    const result = plan({ media: alternate1080pSdr, device, network, policy, caps, selection, mode: "stream" });
    expect(isPlanRefused(result)).toBe(false);
  });
});

describe("UnavailableScreen rendering the real engine's refusal (desktop)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  it("renders every real reason with its matching machine code, copy, and severity dot — nothing hand-authored", () => {
    installMatchMedia(false);
    const result = plan({ media: seededMovie2160pHdr, device, network, policy, caps, selection, mode: "stream" });
    expect(result.reasons.length).toBeGreaterThan(0); // otherwise the assertions below would be vacuous

    view = renderIntoBody(
      <UnavailableScreen
        title="Glass Orchard"
        backdropUrl={null}
        dominantColor={null}
        reasons={result.reasons}
        fallback={null}
        onAcceptFallback={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    const text = view.container.textContent ?? "";
    for (const reason of result.reasons) {
      expect(text).toContain(reason.code);
      expect(text).toContain(describeReasonCode(reason.code).title);
    }

    const dots = Array.from(view.container.querySelectorAll("[data-severity]"));
    expect(dots).toHaveLength(result.reasons.length);
    dots.forEach((dot, i) => {
      expect(dot.getAttribute("data-severity")).toBe(describeReasonCode(result.reasons[i]!.code).severity);
    });

    // Desktop screen form, not a dialog/sheet (design/phosphor/README.md's
    // own Desktop section: "Refusal screen").
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(view.container.textContent).toContain("Back");
  });

  it("LD-1(a): the yellow 'Can't play this right now' sparkle banner is gone entirely", () => {
    installMatchMedia(false);
    const result = plan({ media: seededMovie2160pHdr, device, network, policy, caps, selection, mode: "stream" });
    view = renderIntoBody(
      <UnavailableScreen title="Glass Orchard" backdropUrl={null} dominantColor={null} reasons={result.reasons} fallback={null} onAcceptFallback={vi.fn()} onBack={vi.fn()} />,
    );
    // The banner was a lucide Sparkles icon inside a Tag pill — lucide-react
    // stamps a `lucide-sparkles` class on its own generated <svg>, so its
    // absence proves the glyph (and its wrapping banner) is gone, not just
    // that the same words moved somewhere else.
    expect(view.container.querySelector("svg.lucide-sparkles")).toBeNull();
    // On desktop nothing else says this phrase (the BottomSheet's own title
    // saying it is phone-only — see the phone describe block below), so its
    // total absence here proves the banner, not just its icon, is gone.
    expect(view.container.textContent).not.toContain("Can’t play this right now");
  });

  it("LD-1(b): Back sits at the TOP of the card, left of the SESSION REFUSED badge row — not in a bottom footer", () => {
    installMatchMedia(false);
    const result = plan({ media: seededMovie2160pHdr, device, network, policy, caps, selection, mode: "stream" });
    view = renderIntoBody(
      <UnavailableScreen title="Glass Orchard" backdropUrl={null} dominantColor={null} reasons={result.reasons} fallback={null} onAcceptFallback={vi.fn()} onBack={vi.fn()} />,
    );

    const backButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Back");
    expect(backButton).toBeTruthy();
    const statusPill = Array.from(view.container.querySelectorAll("span")).find((s) => s.textContent?.startsWith("Session refused"));
    expect(statusPill).toBeTruthy();
    const heading = view.container.querySelector("h1");
    expect(heading).toBeTruthy();

    // Back precedes BOTH the badge row (shifts right of it) and the
    // reasons/title content below (top of the card, not a bottom footer).
    expect(backButton!.compareDocumentPosition(statusPill!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(backButton!.compareDocumentPosition(heading!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders no fallback affordance when none is offered (the design's own \"when the plan offers one\" qualifier)", () => {
    installMatchMedia(false);
    const result = plan({ media: seededMovie2160pHdr, device, network, policy, caps, selection, mode: "stream" });
    view = renderIntoBody(
      <UnavailableScreen title="Glass Orchard" backdropUrl={null} dominantColor={null} reasons={result.reasons} fallback={null} onAcceptFallback={vi.fn()} onBack={vi.fn()} />,
    );
    expect(view.container.textContent).not.toContain("Play the");
  });

  it("offers the real alternate version and never auto-plays it — only an explicit tap fires onAcceptFallback", () => {
    installMatchMedia(false);
    const result = plan({ media: seededMovie2160pHdr, device, network, policy, caps, selection, mode: "stream" });
    const onAcceptFallback = vi.fn();
    const candidate = { mediaFileId: "constructed-alt-1080p-h264-sdr", label: "1080p" };
    view = renderIntoBody(
      <UnavailableScreen
        title="Glass Orchard"
        backdropUrl={null}
        dominantColor={null}
        reasons={result.reasons}
        fallback={candidate}
        onAcceptFallback={onAcceptFallback}
        onBack={vi.fn()}
      />,
    );
    expect(view.container.textContent).toContain("Play the 1080p version");
    expect(onAcceptFallback).not.toHaveBeenCalled();

    const button = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Play the 1080p version"));
    button?.click();
    expect(onAcceptFallback).toHaveBeenCalledTimes(1);
    expect(onAcceptFallback).toHaveBeenCalledWith(candidate);
  });

  it("still renders the honest 'no specific reason' fallback for an empty reasons array (unchanged contract)", () => {
    installMatchMedia(false);
    view = renderIntoBody(
      <UnavailableScreen title="Item" backdropUrl={null} dominantColor={null} reasons={[]} fallback={null} onAcceptFallback={vi.fn()} onBack={vi.fn()} />,
    );
    expect(view.container.textContent).toContain("No specific reason was reported.");
  });
});

// d3-aq5 (F/client-error-code-map). A session the SERVER marked failed
// mid-playback reaches this screen carrying `playback_sessions.error_code`
// — a runtime session-death code, not a §4 PlanReasonCode — so a generic
// "unrecognized code" row would be the whole story a viewer gets for a
// crashed transcode. The codes come from ONE place (the worker's
// exit-classify.ts constants), the copy from lib/playback-recovery.ts's
// map, consulted before describeReasonCode. This asserts the wiring
// end-to-end through the screen, with an unmapped code as the negative
// control so it can never pass vacuously.
describe("UnavailableScreen rendering a server-side session failure (d3-aq5)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  function renderFailure(errorCode: string | null): TestRender {
    installMatchMedia(false);
    return renderIntoBody(
      <UnavailableScreen
        title="Glass Orchard"
        backdropUrl={null}
        dominantColor={null}
        reasons={sessionFailureReasons(errorCode)}
        statusCode={undefined}
        fallback={null}
        onAcceptFallback={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  // The two codes the worker writes, mirrored from
  // apps/worker/src/transcode/exit-classify.ts's
  // TRANSCODE_ERROR_CODE_FAILED / _ENCODER_MALFUNCTION (apps/web never
  // imports from apps/worker — same hand-mirroring convention
  // playback-reasons.test.ts uses for the contract's closed enum).
  it.each([
    ["transcode-failed", /transcoder crashed/i],
    ["transcode-encoder-malfunction", /hardware video encoder/i],
  ])("renders dedicated copy for the session errorCode %s, never the generic fallback", (code, detailPattern) => {
    view = renderFailure(code);
    const text = view.container.textContent ?? "";
    expect(text).toContain(code); // the machine code is always shown too
    expect(text).toMatch(detailPattern);
    expect(text).not.toMatch(/this build's reason copy map may be behind/i);
    expect(view.container.querySelector("[data-severity]")?.getAttribute("data-severity")).toBe("blocking");
  });

  it("renders honest copy when the server marked the session failed but recorded NO errorCode", () => {
    view = renderFailure(null);
    const text = view.container.textContent ?? "";
    expect(text).toContain(SESSION_FAILED_CODE);
    expect(text).toContain("Playback session failed");
    expect(text).not.toMatch(/this build's reason copy map may be behind/i);
  });

  it("an unmapped errorCode still falls through to the honest unrecognized-code row (negative control)", () => {
    view = renderFailure("some-future-worker-code");
    const text = view.container.textContent ?? "";
    expect(text).toContain("some-future-worker-code");
    expect(text).toMatch(/this build's reason copy map may be behind/i);
  });
});

// d3-aq6 (A/browser-player-F1). The pill was hard-wired to "SESSION
// REFUSED · PLANNER REASONS, VERBATIM" for every path that reaches this
// screen — including the two that were never refusals: a session the
// SERVER killed mid-playback (it FAILED; its rows are runtime error codes,
// not planner output) and an item that never resolved at all. The variant
// selects the framing; nothing else about the screen changes, and the
// DEFAULT is today's copy byte-for-byte so no existing call site moves.
describe("UnavailableScreen status framing by variant (d3-aq6)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  function render(extra: { variant?: "refused" | "failed" | "unavailable"; statusCode?: number }): TestRender {
    installMatchMedia(false);
    return renderIntoBody(
      <UnavailableScreen
        title="Glass Orchard"
        backdropUrl={null}
        dominantColor={null}
        reasons={sessionFailureReasons("transcode-failed")}
        fallback={null}
        onAcceptFallback={vi.fn()}
        onBack={vi.fn()}
        {...extra}
      />,
    );
  }

  function pillText(v: TestRender): string {
    const pill = Array.from(v.container.querySelectorAll("span")).find((s) => /^(Session refused|Session failed|Unavailable)/.test(s.textContent ?? ""));
    return pill?.textContent ?? "";
  }

  it("defaults to today's refusal copy exactly — omitting the prop changes nothing", () => {
    view = render({ statusCode: 409 });
    expect(pillText(view)).toBe("Session refused · HTTP 409");
    const text = view.container.textContent ?? "";
    expect(text).toContain("Planner reasons, verbatim");
    expect(text).toContain("“Glass Orchard” can’t play on this device right now");
    expect(text).toContain("Here’s exactly why:");
  });

  it("variant='refused' is that same default, spelled out", () => {
    view = render({ variant: "refused", statusCode: 409 });
    expect(pillText(view)).toBe("Session refused · HTTP 409");
    expect(view.container.textContent).toContain("Planner reasons, verbatim");
  });

  it("variant='failed' says the session FAILED and stops calling its rows planner reasons", () => {
    view = render({ variant: "failed" });
    expect(pillText(view)).toBe("Session failed");
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("Session refused");
    expect(text).not.toContain("Planner reasons, verbatim");
    expect(text).toContain("Server error codes, verbatim");
    // The reason rows themselves are untouched by the framing.
    expect(text).toContain("transcode-failed");
  });

  it("variant='unavailable' frames a never-resolved item as unavailable, not refused", () => {
    view = render({ variant: "unavailable", statusCode: 404 });
    expect(pillText(view)).toBe("Unavailable · HTTP 404");
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("Session refused");
    expect(text).not.toContain("Planner reasons, verbatim");
    expect(text).not.toContain("can’t play on this device right now");
  });

  it("carries the framing into the phone sheet's own title too", () => {
    installMatchMedia(true);
    view = renderIntoBody(
      <UnavailableScreen
        title="Glass Orchard"
        backdropUrl={null}
        dominantColor={null}
        reasons={sessionFailureReasons("transcode-failed")}
        variant="failed"
        fallback={null}
        onAcceptFallback={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain("Can’t play this right now");
  });
});

describe("UnavailableScreen rendering the real engine's refusal (phone sheet)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  it("renders the SAME real reasons inside a BottomSheet, and its Done control declines back (never auto-switches)", () => {
    installMatchMedia(true);
    const result = plan({ media: seededMovie2160pHdr, device, network, policy, caps, selection, mode: "stream" });
    const onBack = vi.fn();
    view = renderIntoBody(
      <UnavailableScreen title="Glass Orchard" backdropUrl={null} dominantColor={null} reasons={result.reasons} fallback={null} onAcceptFallback={vi.fn()} onBack={onBack} />,
    );

    const dialog = view.container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull(); // BottomSheet, not the plain desktop panel
    const text = view.container.textContent ?? "";
    for (const reason of result.reasons) expect(text).toContain(reason.code);

    // LD-1(a) applies to the phone sheet too — the sparkle banner glyph is
    // gone (the sheet's own title text still legitimately says "Can't play
    // this right now" as its accessible heading, which is a different
    // element from the removed banner — so this checks the icon, not the
    // words).
    expect(view.container.querySelector("svg.lucide-sparkles")).toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

// SPF-7 Phase B: the code line's aria-label, the "Copy details" affordance
// beside it, and the optional "Try again" action.
describe("SPF-7 Phase B: error code line, Copy details, Try again", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function installClipboard(): { writeText: ReturnType<typeof vi.fn> } {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    return { writeText };
  }

  function findButton(container: HTMLElement, text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
    if (!button) throw new Error(`no button found containing "${text}"`);
    return button;
  }

  it("the code line carries an 'Error code' aria-label for assistive tech", () => {
    installMatchMedia(false);
    view = renderIntoBody(
      <UnavailableScreen
        title="Arrival"
        backdropUrl={null}
        dominantColor={null}
        reasons={sessionFailureReasons("transcode-failed")}
        fallback={null}
        onAcceptFallback={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    const codeEl = view.container.querySelector('[aria-label="Error code"]');
    expect(codeEl).not.toBeNull();
    expect(codeEl?.textContent).toContain("transcode-failed");
  });

  it("Copy details writes <title> · <code> · <detail> · HTTP <status> · session <id> · <ISO time> to the clipboard", () => {
    installMatchMedia(false);
    const { writeText } = installClipboard();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    view = renderIntoBody(
      <UnavailableScreen
        title="Arrival"
        backdropUrl={null}
        dominantColor={null}
        reasons={[{ code: "transcode-failed", streamIndex: null, detail: "exit code 1" }]}
        statusCode={500}
        sessionId="sess-1"
        variant="failed"
        fallback={null}
        onAcceptFallback={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    findButton(view.container, "Copy details").click();
    expect(writeText).toHaveBeenCalledWith(
      "Transcoding failed on the server · transcode-failed · exit code 1 · HTTP 500 · session sess-1 · 2026-09-03T12:00:00.000Z",
    );
  });

  it("a reason with no detail copies 'no detail' rather than a blank/undefined segment", () => {
    installMatchMedia(false);
    const { writeText } = installClipboard();
    view = renderIntoBody(
      <UnavailableScreen
        title="Arrival"
        backdropUrl={null}
        dominantColor={null}
        reasons={sessionFailureReasons(null)}
        fallback={null}
        onAcceptFallback={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    findButton(view.container, "Copy details").click();
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toContain("no detail");
    expect(copied).toContain(`HTTP ?`);
    expect(copied).toContain("session ?");
  });

  it("a denied/absent Clipboard API falls back gracefully — no throw, no crash", () => {
    installMatchMedia(false);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    view = renderIntoBody(
      <UnavailableScreen
        title="Arrival"
        backdropUrl={null}
        dominantColor={null}
        reasons={sessionFailureReasons("transcode-failed")}
        fallback={null}
        onAcceptFallback={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(() => findButton(view!.container, "Copy details").click()).not.toThrow();
  });

  it("renders no 'Try again' button when onRetry is omitted", () => {
    installMatchMedia(false);
    view = renderIntoBody(
      <UnavailableScreen
        title="Arrival"
        backdropUrl={null}
        dominantColor={null}
        reasons={sessionFailureReasons("transcode-failed")}
        fallback={null}
        onAcceptFallback={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(view.container.textContent).not.toContain("Try again");
  });

  it("renders a primary 'Try again' button on desktop, wired to onRetry", () => {
    installMatchMedia(false);
    const onRetry = vi.fn();
    view = renderIntoBody(
      <UnavailableScreen
        title="Arrival"
        backdropUrl={null}
        dominantColor={null}
        reasons={sessionFailureReasons("transcode-failed")}
        fallback={null}
        onAcceptFallback={vi.fn()}
        onBack={vi.fn()}
        onRetry={onRetry}
      />,
    );
    findButton(view.container, "Try again").click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the SAME 'Try again' button on the phone sheet, wired to onRetry", () => {
    installMatchMedia(true);
    const onRetry = vi.fn();
    view = renderIntoBody(
      <UnavailableScreen
        title="Arrival"
        backdropUrl={null}
        dominantColor={null}
        reasons={sessionFailureReasons("transcode-failed")}
        fallback={null}
        onAcceptFallback={vi.fn()}
        onBack={vi.fn()}
        onRetry={onRetry}
      />,
    );
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull(); // still the BottomSheet form
    findButton(view.container, "Try again").click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
