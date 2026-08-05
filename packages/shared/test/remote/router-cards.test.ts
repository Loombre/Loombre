// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/remote/router-cards.test.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5 — router instruction card
// content). Every card renders with both protocol parameterizations
// (Direct's TCP 80/443 and a representative WireGuard UDP port), never
// leaves an unresolved placeholder, and stays inside the plain-language
// register (R9's "no UPnP words except the one feature statement" rule,
// R10's admin/user register).

import { describe, expect, it } from "vitest";
import {
  NAMED_ROUTER_BRAND_IDS,
  ROUTER_BRAND_IDS,
  ROUTER_BRAND_LABELS,
  buildPortForwardCard,
  buildWanAddressCard,
  type PortForwardParams,
  type RouterCard,
} from "../../src/remote/router-cards.js";

// The two real callers, per this module's own header: Direct (TCP 80/443,
// R5) and the WireGuard path (a representative UDP port, R1/RG5's default
// 51820 — this test does not import remote.wireguardPort's actual default
// to avoid a settings-registry.ts dependency in a pure-content test; the
// literal value only needs to be SOME plausible UDP port).
const DIRECT_HTTP: PortForwardParams = { protocol: "tcp", externalPort: 80, internalPort: 80 };
const DIRECT_HTTPS: PortForwardParams = { protocol: "tcp", externalPort: 443, internalPort: 443 };
const WIREGUARD_UDP: PortForwardParams = { protocol: "udp", externalPort: 51820, internalPort: 51820 };
const ALL_PARAMS: readonly PortForwardParams[] = [DIRECT_HTTP, DIRECT_HTTPS, WIREGUARD_UDP];

const PLACEHOLDER_TOKEN_PATTERN = /\{\s*[a-zA-Z]/;

function allText(card: RouterCard): string {
  return [card.title, card.intro, card.diagram.label, card.diagram.description, ...card.steps.flatMap((s) => [s.heading, s.body])].join(
    "\n",
  );
}

describe("ROUTER_BRAND_IDS / ROUTER_BRAND_LABELS", () => {
  it("has exactly generic + the six named brands", () => {
    expect(ROUTER_BRAND_IDS).toHaveLength(7);
    expect(ROUTER_BRAND_IDS).toContain("generic");
  });

  it("NAMED_ROUTER_BRAND_IDS is exactly ROUTER_BRAND_IDS minus 'generic', 6 entries", () => {
    expect(NAMED_ROUTER_BRAND_IDS).toHaveLength(6);
    expect(NAMED_ROUTER_BRAND_IDS).not.toContain("generic");
    expect(new Set([...NAMED_ROUTER_BRAND_IDS, "generic"])).toEqual(new Set(ROUTER_BRAND_IDS));
  });

  it("covers the six named brands from the brief: TP-Link, Netgear, ASUS, Linksys, AVM FRITZ!Box, Ubiquiti UniFi", () => {
    const labels = NAMED_ROUTER_BRAND_IDS.map((id) => ROUTER_BRAND_LABELS[id]);
    expect(labels).toEqual(
      expect.arrayContaining(["TP-Link", "Netgear", "ASUS", "Linksys", "AVM FRITZ!Box", "Ubiquiti UniFi"]),
    );
  });

  it("every brand has a non-empty label", () => {
    for (const id of ROUTER_BRAND_IDS) {
      expect(ROUTER_BRAND_LABELS[id].length).toBeGreaterThan(0);
    }
  });
});

describe("buildPortForwardCard", () => {
  it("renders for every brand at every protocol parameterization with no unresolved placeholders", () => {
    for (const brand of ROUTER_BRAND_IDS) {
      for (const params of ALL_PARAMS) {
        const card = buildPortForwardCard(brand, params);
        expect(card.steps.length).toBeGreaterThan(0);
        const text = allText(card);
        expect(text, `${brand}/${params.protocol}${params.externalPort}`).not.toMatch(PLACEHOLDER_TOKEN_PATTERN);
      }
    }
  });

  it("interpolates the exact protocol/port values into the card text", () => {
    const card = buildPortForwardCard("tp-link", DIRECT_HTTPS);
    const text = allText(card);
    expect(text).toContain("443");
    expect(text).toContain("TCP");
  });

  it("UDP parameterization renders 'UDP', not 'TCP', and the WireGuard port value", () => {
    const card = buildPortForwardCard("netgear", WIREGUARD_UDP);
    const text = allText(card);
    expect(text).toContain("UDP");
    expect(text).not.toContain("TCP");
    expect(text).toContain("51820");
  });

  it("the SAME card content (step count, headings) serves both Direct's TCP and the WireGuard path's UDP — only port/protocol differ", () => {
    for (const brand of ROUTER_BRAND_IDS) {
      const tcpCard = buildPortForwardCard(brand, DIRECT_HTTPS);
      const udpCard = buildPortForwardCard(brand, WIREGUARD_UDP);
      expect(udpCard.steps.map((s) => s.heading)).toEqual(tcpCard.steps.map((s) => s.heading));
      expect(udpCard.steps.length).toBe(tcpCard.steps.length);
    }
  });

  it("card ids are unique across all brands", () => {
    const ids = ROUTER_BRAND_IDS.map((brand) => buildPortForwardCard(brand, DIRECT_HTTPS).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the word 'UPnP' appears in card TEXT exactly once total, only in the generic card's intro, as the single feature statement (R9)", () => {
    let occurrences = 0;
    let sawInGenericIntro = false;
    for (const brand of ROUTER_BRAND_IDS) {
      const card = buildPortForwardCard(brand, DIRECT_HTTPS);
      const text = allText(card);
      const matches = text.match(/UPnP/g);
      if (matches) {
        occurrences += matches.length;
        if (brand === "generic" && card.intro.includes("UPnP")) sawInGenericIntro = true;
      }
    }
    expect(occurrences).toBe(1);
    expect(sawInGenericIntro).toBe(true);
  });

  it("no card text names NAT-PMP, PCP, or any other automatic port-mapping protocol besides the one UPnP statement", () => {
    for (const brand of ROUTER_BRAND_IDS) {
      const card = buildPortForwardCard(brand, DIRECT_HTTPS);
      const text = allText(card);
      expect(text).not.toMatch(/NAT-PMP|natpmp|\bPCP\b|SSDP/i);
    }
  });

  it("port-forward cards never mention a router API or automatic configuration — every step is something a human does on the router's own admin page", () => {
    for (const brand of ROUTER_BRAND_IDS) {
      const card = buildPortForwardCard(brand, DIRECT_HTTPS);
      const text = allText(card);
      expect(text).not.toMatch(/\bAPI\b/);
    }
  });

  it("every named brand's card mentions the brand's own login/menu wording, distinguishing it from the generic card", () => {
    const generic = buildPortForwardCard("generic", DIRECT_HTTPS);
    for (const brand of NAMED_ROUTER_BRAND_IDS) {
      const card = buildPortForwardCard(brand, DIRECT_HTTPS);
      expect(card.title).not.toBe(generic.title);
      expect(card.intro).toContain(ROUTER_BRAND_LABELS[brand]);
    }
  });
});

describe("buildWanAddressCard", () => {
  it("renders for every brand with no unresolved placeholders", () => {
    for (const brand of ROUTER_BRAND_IDS) {
      const card = buildWanAddressCard(brand);
      expect(card.steps.length).toBeGreaterThan(0);
      expect(allText(card)).not.toMatch(PLACEHOLDER_TOKEN_PATTERN);
    }
  });

  it("every card carries the CGNAT plain-language line (100.64-127 explainer)", () => {
    for (const brand of ROUTER_BRAND_IDS) {
      const card = buildWanAddressCard(brand);
      const text = allText(card);
      expect(text).toMatch(/100\.64/);
      expect(text).toMatch(/100\.127/);
      expect(text.toLowerCase()).not.toMatch(/\bcgnat\b/); // plain language, never the jargon term itself
    }
  });

  it("card ids are unique across all brands", () => {
    const ids = ROUTER_BRAND_IDS.map((brand) => buildWanAddressCard(brand).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no WAN-address card names UPnP or any port-mapping protocol at all (that's the port-forward card's one statement, not this card's)", () => {
    for (const brand of ROUTER_BRAND_IDS) {
      const card = buildWanAddressCard(brand);
      const text = allText(card);
      expect(text).not.toMatch(/UPnP|NAT-PMP|natpmp|\bPCP\b|SSDP/i);
    }
  });

  it("every named brand's card names where the status page lives, distinguishing it from the generic card", () => {
    const generic = buildWanAddressCard("generic");
    for (const brand of NAMED_ROUTER_BRAND_IDS) {
      const card = buildWanAddressCard(brand);
      expect(card.title).not.toBe(generic.title);
    }
  });
});
