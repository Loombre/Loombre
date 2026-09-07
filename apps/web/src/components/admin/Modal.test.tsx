// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/Modal.test.tsx
//
// The generic admin modal's width variant: the default frame is the 480px
// per-field editor; `size="wide"` is for panels that need more (the Stash
// setup was clipped at 480px on the Linux reference box — Save entirely
// outside the dialog).

import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";
import { Modal } from "./Modal.js";
import styles from "./Modal.module.css";

let view: TestRender | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

describe("Modal size", () => {
  it("default: no wide class; size=\"wide\": the dialog carries the wide class", () => {
    view = renderIntoBody(
      <Modal title="Default" onClose={() => {}}>
        <span>body</span>
      </Modal>,
    );
    const plain = view.container.querySelector('[role="dialog"]')!;
    expect(plain.className.split(" ")).not.toContain(styles.dialogWide);
    view.unmount();

    view = renderIntoBody(
      <Modal title="Wide" onClose={() => {}} size="wide">
        <span>body</span>
      </Modal>,
    );
    const wide = view.container.querySelector('[role="dialog"]')!;
    expect(wide.className.split(" ")).toContain(styles.dialogWide);
  });

  it("the wide rule sizes to content up to the viewport and the frame never scrolls horizontally", () => {
    const css = readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "Modal.module.css"), "utf8");
    expect(css).toMatch(/\.dialogWide\s*\{[^}]*width:\s*min\(760px,\s*92vw\)/);
    expect(css).toMatch(/\.dialog\s*\{[^}]*overflow:\s*hidden auto/);
  });
});
