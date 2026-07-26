// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/ui/test-render.tsx
//
// Minimal render harness for the component tests in this directory
// (BottomSheet/Toast/SheetOrModal). No new dependency: this repo has no
// @testing-library/react (HARD LINE — no new npm deps for the Phosphor
// W1b lane), so this wraps exactly what the apps/web devDependencies
// already provide — react-dom/client + React 19's own `act` export — in
// the ~15 lines every one of those test files would otherwise repeat.
// Test-only: not part of the components/ui public API, never imported by
// application code.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";

export interface TestRender {
  container: HTMLDivElement;
  root: Root;
  rerender: (node: ReactNode) => void;
  unmount: () => void;
}

export function renderIntoBody(node: ReactNode): TestRender {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    root,
    rerender(next: ReactNode) {
      act(() => {
        root.render(next);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}
