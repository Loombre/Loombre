// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/VersionCard.test.tsx
//
// REGRESSION GUARD (browser-items-F6, P3): the VERSIONS card must not
// assert a confident "SDR" for a file whose HDR status is genuinely
// unknown. `hdr: null` (no derivable signal — packages/db's
// deriveHdrForDisplay returns null when the stored hdr column is unset AND
// color_transfer gives no HDR evidence either) must render NO SDR/HDR
// segment at all, distinct from `hdr: "none"` (a real probed no-HDR
// verdict), which still renders "SDR". See VersionCard.tsx's hdrLabel()
// doc comment for the null-vs-"none" distinction this guards.

import { afterEach, describe, expect, it } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";
import { VersionCard } from "./VersionCard.js";

type MediaFileSummary = components["schemas"]["MediaFileSummary"];

function makeFile(overrides: Partial<MediaFileSummary> = {}): MediaFileSummary {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    versionLabel: null,
    container: "mkv",
    width: 3840,
    height: 2160,
    sizeBytes: 6_400_000_000,
    durationMs: 6_480_000,
    videoCodec: "hevc",
    bitDepth: 10,
    ...overrides,
  };
}

describe("VersionCard hdr display (browser-items-F6)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it('omits the HDR/SDR segment entirely when hdr is null (no derivable signal) — does NOT assert "SDR"', () => {
    const file = makeFile({ hdr: null });
    view = renderIntoBody(<VersionCard file={file} />);
    expect(view.container.textContent).not.toContain("SDR");
    expect(view.container.textContent).toContain("HEVC");
  });

  it('renders "SDR" for a real, probed hdr: "none" verdict', () => {
    const file = makeFile({ hdr: "none" });
    view = renderIntoBody(<VersionCard file={file} />);
    expect(view.container.textContent).toContain("SDR");
  });

  it('renders "HDR10" for hdr: "hdr10" (e.g. deriveHdrForDisplay reading a PQ color_transfer back)', () => {
    const file = makeFile({ hdr: "hdr10" });
    view = renderIntoBody(<VersionCard file={file} />);
    expect(view.container.textContent).toContain("HDR10");
    expect(view.container.textContent).not.toContain("SDR");
  });

  it('renders "Dolby Vision" for hdr: "dv"', () => {
    const file = makeFile({ hdr: "dv" });
    view = renderIntoBody(<VersionCard file={file} />);
    expect(view.container.textContent).toContain("Dolby Vision");
  });
});
