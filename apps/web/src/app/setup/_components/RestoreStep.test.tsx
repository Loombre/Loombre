// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/setup/_components/RestoreStep.test.tsx
//
// L3 (UIFIX-2026-08-29). The restore step drew a dashed dropzone and wired
// no drag handlers to it at all, so dropping an archive on it did what
// dropping a file on any un-cancelled page does: the browser navigated away
// from the half-finished wizard to render the JSON, losing the setup run.
//
// This is a component test rather than a screenshot on purpose — /setup is
// unreachable on a configured server (the route bounces once setup state
// says the instance is provisioned), so the live surface cannot be captured.
// What matters here is behaviour, not pixels: the handlers must exist, they
// must preventDefault (that cancellation IS the fix — without it the drop
// is a navigation no matter what else runs), and a dropped file must reach
// the SAME upload path the <input> uses, not a second copy of it.
//
// apiGet/apiPost are mocked and the module under test imported afterwards —
// the established convention here (LibraryStep.test.tsx, RestrictedStep).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../../components/ui/test-render.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
}));

const { RestoreStep } = await import("./RestoreStep.js");

/** The wizard flags that put the step in its "offer" view — the only view
 *  that renders a dropzone (deriveRestoreViewState → canOfferRestore). */
const OFFER_FLAGS = { adminCreated: true, libraryCreatedThisSession: false };

/** jsdom implements neither DragEvent nor DataTransfer. React reads
 *  `dataTransfer` straight off the native event, so a plain cancelable
 *  Event carrying that one property is exactly what its synthetic drag
 *  event needs — and `defaultPrevented` on the object we dispatched is then
 *  a truthful record of whether the component cancelled it. */
function dispatchDrag(el: Element, type: string, files: File[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, items: [], types: files.length ? ["Files"] : [] },
  });
  return event;
}

describe("RestoreStep — the dropzone is a real drop target (L3)", () => {
  let view: TestRender | null = null;
  const onNext = vi.fn();

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    onNext.mockReset();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  /** The dropzone is located STRUCTURALLY — it is the box the file input
   *  sits in — rather than by a test hook, so this suite fails on the
   *  missing BEHAVIOUR when the wiring is absent, not on a missing
   *  attribute it asked the component to carry for its own convenience. */
  function renderOffer(): HTMLElement {
    view = renderIntoBody(<RestoreStep flags={OFFER_FLAGS} onNext={onNext} />);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input, "the offer view must render a file input").not.toBeNull();
    const zone = input!.parentElement;
    expect(zone, "the file input must sit inside the dropzone").not.toBeNull();
    return zone!;
  }

  async function fire(el: Element, type: string, files: File[] = []): Promise<Event> {
    const event = dispatchDrag(el, type, files);
    await act(async () => {
      el.dispatchEvent(event);
      await Promise.resolve();
    });
    return event;
  }

  it("a drag over the zone marks it, and cancels the event so a drop can land", async () => {
    const zone = renderOffer();
    expect(zone.dataset["dragover"]).toBeUndefined();

    const enter = await fire(zone, "dragenter");
    expect(zone.dataset["dragover"]).toBe("true");
    expect(enter.defaultPrevented, "dragenter must be cancelled").toBe(true);

    const over = await fire(zone, "dragover");
    expect(zone.dataset["dragover"]).toBe("true");
    // The one that actually matters: a drop is only permitted when the last
    // dragover on the target was cancelled.
    expect(over.defaultPrevented, "dragover must be cancelled").toBe(true);
  });

  it("dragging back out clears the marker", async () => {
    const zone = renderOffer();
    await fire(zone, "dragenter");
    expect(zone.dataset["dragover"]).toBe("true");

    await fire(zone, "dragleave");
    expect(zone.dataset["dragover"]).toBeUndefined();
  });

  it("a dropped archive is cancelled (never a navigation) and goes through the input's own upload path", async () => {
    apiPostMock.mockResolvedValue({ jobId: "job-1" });
    apiGetMock.mockResolvedValue({ status: "completed", lastError: null });
    const zone = renderOffer();
    await fire(zone, "dragenter");

    const archive = new File(['{"schemaVersion":1}'], "loombre-export.json", { type: "application/json" });
    const drop = await fire(zone, "drop", [archive]);

    expect(drop.defaultPrevented, "drop must be cancelled or the browser navigates to the file").toBe(true);
    expect(zone.dataset["dragover"], "the marker clears once the file is taken").toBeUndefined();

    // Reaching apiPost("/import", …) with the PARSED body is the proof that
    // the drop landed in ingestArchive — the file input's path — rather than
    // in some second, hand-rolled upload.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]?.[0]).toBe("/import");
    expect(apiPostMock.mock.calls[0]?.[1]).toEqual({ body: { schemaVersion: 1 } });
  });

  it("a dropped file that is not JSON reports the input path's own error, and still cancels the event", async () => {
    const zone = renderOffer();
    const notJson = new File(["not json at all"], "notes.txt", { type: "text/plain" });
    const drop = await fire(zone, "drop", [notJson]);

    expect(drop.defaultPrevented).toBe(true);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(view!.container.textContent).toMatch(/isn't valid JSON/i);
  });

  it("a drop carrying no file is still cancelled — an empty drop must not navigate either", async () => {
    const zone = renderOffer();
    const drop = await fire(zone, "drop", []);

    expect(drop.defaultPrevented).toBe(true);
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
