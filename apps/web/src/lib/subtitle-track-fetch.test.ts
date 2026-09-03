// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/subtitle-track-fetch.test.ts

import { describe, expect, it, vi } from "vitest";
import { fetchSubtitleTrackObjectUrl } from "./subtitle-track-fetch.js";

function response(
  status: number,
  body = "",
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function deps(maxAttempts = 4) {
  const created: Blob[] = [];
  const fetchImpl = vi.fn<FetchFn>();
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
  const createObjectUrl = vi.fn<(blob: Blob) => string>((blob) => {
    created.push(blob);
    return `blob:test/${created.length}`;
  });
  return {
    created,
    fetchImpl,
    sleep,
    createObjectUrl,
    options: { fetchImpl, sleep, createObjectUrl, maxAttempts },
  };
}

describe("fetchSubtitleTrackObjectUrl", () => {
  it("fetches the VTT with a CORS request (never a bare <track src>) and returns a same-origin blob URL", async () => {
    const d = deps();
    d.fetchImpl.mockResolvedValueOnce(
      response(200, "WEBVTT\n\n00:00.000 --> 00:02.000\nhi\n", {
        "content-type": "text/vtt",
      }),
    );
    const url = await fetchSubtitleTrackObjectUrl(
      "http://server.test/playback/sessions/s1/subtitles/sub0.vtt?token=t",
      d.options,
    );
    expect(url).toBe("blob:test/1");
    expect(d.fetchImpl).toHaveBeenCalledWith(
      "http://server.test/playback/sessions/s1/subtitles/sub0.vtt?token=t",
      expect.objectContaining({ mode: "cors" }),
    );
    expect(d.created[0]?.type).toBe("text/vtt");
    expect(await d.created[0]?.text()).toContain("WEBVTT");
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("retries while the worker is still extracting — 503 subtitle-not-ready (honouring Retry-After) and 404 alike", async () => {
    const d = deps();
    d.fetchImpl
      .mockResolvedValueOnce(response(503, "{}", { "retry-after": "1" }))
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(
        response(200, "WEBVTT\n", { "content-type": "text/vtt" }),
      );
    const url = await fetchSubtitleTrackObjectUrl(
      "http://server.test/x.vtt",
      d.options,
    );
    expect(url).toBe("blob:test/1");
    expect(d.fetchImpl).toHaveBeenCalledTimes(3);
    expect(d.sleep).toHaveBeenNthCalledWith(1, 1000); // Retry-After: 1
    expect(d.sleep).toHaveBeenNthCalledWith(2, expect.any(Number)); // the 404 default backoff
  });

  it("gives up after maxAttempts and returns null (no track rather than a broken one)", async () => {
    const d = deps(3);
    d.fetchImpl.mockResolvedValue(response(503, "{}", { "retry-after": "1" }));
    expect(
      await fetchSubtitleTrackObjectUrl("http://server.test/x.vtt", d.options),
    ).toBeNull();
    expect(d.fetchImpl).toHaveBeenCalledTimes(3);
    expect(d.createObjectUrl).not.toHaveBeenCalled();
  });

  it("a non-retryable failure (401, network error) returns null immediately", async () => {
    const d = deps();
    d.fetchImpl.mockResolvedValueOnce(response(401));
    expect(
      await fetchSubtitleTrackObjectUrl("http://server.test/x.vtt", d.options),
    ).toBeNull();
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);

    const e = deps();
    e.fetchImpl.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(
      await fetchSubtitleTrackObjectUrl("http://server.test/x.vtt", e.options),
    ).toBeNull();
    expect(e.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
