// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/PersonCard.test.tsx
//
// Cast portraits: a credit renders the ingested `thumb` portrait ONLY when
// the server's PersonCredit.images says one exists — otherwise the initials
// Avatar, never a speculative <img> that 404s for every unmatched person
// (127 credits on one film on the reference box).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { PersonCard, hasPortrait } = await import("./PersonCard.js");

type PersonCredit = components["schemas"]["PersonCredit"];

const PERSON_ID = "01920000-0000-7000-8000-00000000abcd";

function credit(overrides: Partial<PersonCredit> = {}): PersonCredit {
  return { id: PERSON_ID, name: "Natalie Portman", role: "actor", credit: "Jane Foster", order: 0, images: [], ...overrides };
}

const THUMB = { kind: "thumb" as const, width: null, height: null, blurhash: null, dominantColor: null };

let render: TestRender | null = null;
afterEach(() => {
  render?.unmount();
  render = null;
});

describe("PersonCard", () => {
  it("renders the initials avatar, and no <img>, when the credit carries no images", () => {
    render = renderIntoBody(<PersonCard person={credit()} serverUrl="http://srv" accessToken="tok" />);
    expect(render.container.querySelector("img")).toBeNull();
    const avatar = render.container.querySelector('[role="img"]');
    expect(avatar?.getAttribute("aria-label")).toBe("Natalie Portman");
    expect(render.container.querySelector("a")?.getAttribute("href")).toBe(`/people/${PERSON_ID}`);
  });

  it("renders the portrait <img> from GET /images/person/{id}/thumb when a thumb image exists", () => {
    render = renderIntoBody(<PersonCard person={credit({ images: [THUMB] })} serverUrl="http://srv" accessToken="tok" />);
    const img = render.container.querySelector("img");
    expect(img).not.toBeNull();
    const src = img!.getAttribute("src") ?? "";
    expect(src.startsWith(`http://srv/images/person/${PERSON_ID}/thumb?`)).toBe(true);
    expect(src).toContain("token=tok");
    expect(src).toContain("width=192");
    expect(render.container.querySelector('[role="img"]')).toBeNull();
  });

  it("falls back to the avatar without a session to sign the image URL, and treats a non-thumb image as no portrait", () => {
    render = renderIntoBody(<PersonCard person={credit({ images: [THUMB] })} />);
    expect(render.container.querySelector("img")).toBeNull();
    expect(hasPortrait(credit({ images: [{ ...THUMB, kind: "poster" }] }))).toBe(false);
    expect(hasPortrait(credit())).toBe(false);
    expect(hasPortrait(credit({ images: [THUMB] }))).toBe(true);
  });
});
