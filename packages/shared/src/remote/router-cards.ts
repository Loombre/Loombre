// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/remote/router-cards.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5 — router instruction card
// CONTENT). Pure, framework-free (CLAUDE.md invariant 2's playback-engine
// discipline extended to this module, same as provisioning.ts/wizard-
// state.ts/posture-model.ts/diagnosis.ts: no I/O, nothing read from disk/
// network/env) — a typed DATA module the web wizard (U-lane) renders, and
// the docs generator (DOC lane, R10) consumes for the SAME reference
// content rather than a second hand-written copy.
//
// CONTENT-ONLY, HARD LINE (Run posture, R9, RG14): this module names no
// router API, calls nothing, and configures nothing — every card is
// instructions for a HUMAN to carry out on a router's own web admin page.
// The word "UPnP" appears in exactly ONE place below (the generic card's
// intro) as the single feature statement R9 requires ("no UPnP anywhere");
// nowhere else in this file names UPnP, NAT-PMP, PCP, or any other
// automatic port-mapping protocol.
//
// PARAMETERIZED by {protocol, externalPort, internalPort} (packages/shared/
// test/remote/router-cards.test.ts renders every card at both the Direct
// path's TCP 80/443 and a representative WireGuard-path UDP port) so the
// SAME card content serves both the Direct path (D1, this lane) and the
// Remote (WireGuard) path (a later lane) without a second copy of the same
// generic-router-UI knowledge — only the concrete port/protocol values
// differ between callers.
//
// REGISTER: every card renders to an end admin who may have never opened
// their router's admin page before (R10's admin/user registers) — plain
// language throughout, no jargon beyond what the SAME sentence explains
// (e.g. "WAN" is always paired with "the address your internet connection
// itself uses" on first use in a card, never assumed known).

export type PortForwardProtocol = "tcp" | "udp";

export interface PortForwardParams {
  readonly protocol: PortForwardProtocol;
  readonly externalPort: number;
  readonly internalPort: number;
}

/** A described placeholder for an illustrative screenshot/diagram — this
 *  module carries no images (framework-free, R5), only what one should
 *  show and a plain-language caption a renderer without the real image yet
 *  can still show as alt text. */
export interface DiagramSlot {
  readonly label: string;
  readonly description: string;
}

export interface RouterCardStep {
  readonly heading: string;
  readonly body: string;
}

export interface RouterCard {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly steps: readonly RouterCardStep[];
  readonly diagram: DiagramSlot;
}

/** "generic" covers any router not named below — the SAME five-step shape
 *  every brand card also follows, described in vendor-neutral terms. */
export type RouterBrandId = "generic" | "tp-link" | "netgear" | "asus" | "linksys" | "fritzbox" | "unifi";

export const ROUTER_BRAND_LABELS: Readonly<Record<RouterBrandId, string>> = {
  generic: "Other / not listed here",
  "tp-link": "TP-Link",
  netgear: "Netgear",
  asus: "ASUS",
  linksys: "Linksys",
  fritzbox: "AVM FRITZ!Box",
  unifi: "Ubiquiti UniFi",
};

export const ROUTER_BRAND_IDS: readonly RouterBrandId[] = ["generic", "tp-link", "netgear", "asus", "linksys", "fritzbox", "unifi"];

/** The six NAMED brands only (excludes "generic") — for a UI that lists
 *  brand choices with a separate "other" fallback affordance. */
export const NAMED_ROUTER_BRAND_IDS: readonly Exclude<RouterBrandId, "generic">[] = [
  "tp-link",
  "netgear",
  "asus",
  "linksys",
  "fritzbox",
  "unifi",
];

function protocolLabel(protocol: PortForwardProtocol): string {
  return protocol.toUpperCase();
}

// ============================================================================
// Port forwarding — the generic card + per-brand menu-path knowledge
// ============================================================================

interface PortForwardBrandInfo {
  /** How this brand's admin page is normally reached — a typical LAN
   *  address or hostname, stated as a starting guess, never a promise. */
  addressHint: string;
  /** Where the sign-in credentials usually come from. */
  signInHint: string;
  /** The menu path to the port-forwarding screen, in this brand's own
   *  wording — rendered directly after "look for". */
  menuPath: string;
  /** Any brand-specific quirk about the fields on that screen worth
   *  calling out (e.g. a field that doesn't exist on some models). */
  fieldNote?: string;
}

const PORT_FORWARD_BRAND_INFO: Readonly<Record<Exclude<RouterBrandId, "generic">, PortForwardBrandInfo>> = {
  "tp-link": {
    addressHint: "tplinkwifi.net, or 192.168.0.1 / 192.168.1.1 — printed on a label on the router itself",
    signInHint: "the admin username and password printed on that same label, unless you changed them",
    menuPath: '"Advanced" → "NAT Forwarding" → "Virtual Servers" (older menus: "Forwarding" → "Virtual Servers")',
    fieldNote: 'Give the rule any name you like under "Service Type" — it is just a label for your own reference.',
  },
  netgear: {
    addressHint: "192.168.1.1, or routerlogin.net — printed on a label on the router itself",
    signInHint: "the admin username and password printed on that same label, unless you changed them",
    menuPath: '"Advanced" → "Advanced Setup" → "Port Forwarding / Port Triggering", with "Port Forwarding" selected',
    fieldNote: "Some Netgear models only let the internal port match the external port — if there's no separate internal-port field, that's expected; just use the same number for both.",
  },
  asus: {
    addressHint: "192.168.1.1, or router.asus.com — printed on a label on the router or its box",
    signInHint: "the admin username and password printed on that same label, unless you changed them",
    menuPath: '"WAN" → "Virtual Server / Port Forwarding" (on some firmware versions: "Adaptive QoS" → "Open NAT")',
    fieldNote: 'Switch "Enable Port Forwarding" on first — the fields below only appear once it is.',
  },
  linksys: {
    addressHint: "192.168.1.1, or myrouter.local on newer app-managed models",
    signInHint: "the admin username and password you set when the router was first configured",
    menuPath: '"Security" → "Apps and Gaming" → "Single Port Forwarding"',
    fieldNote: 'Give the rule any name under "Application Name" — it is just a label for your own reference.',
  },
  fritzbox: {
    addressHint: "fritz.box, or 192.168.178.1",
    signInHint: "the FRITZ!Box password you set when the router was first configured (there is no separate username)",
    menuPath: '"Internet" → "Permit Access" → "Port Sharing"',
    fieldNote: "FRITZ!Box already knows every device on your network by name — pick this Loombre server from the device list instead of typing its address by hand.",
  },
  unifi: {
    addressHint: "the UniFi Network application (a phone or desktop app, or a web console) — not a per-router address like the others",
    signInHint: "your UniFi account, the same one used to set up the network",
    menuPath: '"Settings" → "Internet" → "Port Forwarding" (older versions: "Settings" → "Routing & Firewall" → "Port Forwarding")',
    fieldNote: 'Choose "Create New Port Forward" to start a new rule.',
  },
};

function genericPortForwardSteps(params: PortForwardParams): readonly RouterCardStep[] {
  const protocol = protocolLabel(params.protocol);
  return [
    {
      heading: "Find your router's address",
      body: "On a device connected to your home network, open a web browser and type your router's address into the address bar — often something like 192.168.0.1 or 192.168.1.1. Check the label on the router itself, or look up \"default gateway\" in your device's network settings if you're not sure.",
    },
    {
      heading: "Sign in",
      body: "Sign in with the router's admin username and password — often printed on a sticker on the router itself, or whatever you set when it was first configured. This is different from your Wi-Fi password.",
    },
    {
      heading: "Find the port-forwarding section",
      body: 'Look for a menu with a name like "Port Forwarding", "Virtual Server", "NAT Forwarding", or "Applications & Gaming" — usually grouped under an "Advanced" or "WAN" heading.',
    },
    {
      heading: "Create the rule",
      body: `Create a new rule with: external (or "WAN") port ${params.externalPort}, internal (or "LAN") port ${params.internalPort}, protocol ${protocol}, and the internal IP address set to this Loombre server's own address on your local network (Settings → Server shows it, or check your operating system's network settings).`,
    },
    {
      heading: "Save, and reboot if asked",
      body: "Save or apply the rule. If the router offers to reboot to apply it, let it — most don't need to, but a few older models do.",
    },
  ];
}

function brandPortForwardSteps(brand: Exclude<RouterBrandId, "generic">, params: PortForwardParams): readonly RouterCardStep[] {
  const info = PORT_FORWARD_BRAND_INFO[brand];
  const protocol = protocolLabel(params.protocol);
  const steps: RouterCardStep[] = [
    {
      heading: "Find your router's address",
      body: `On a device connected to your home network, open a web browser and go to ${info.addressHint}.`,
    },
    {
      heading: "Sign in",
      body: `Sign in with ${info.signInHint}. This is different from your Wi-Fi password.`,
    },
    {
      heading: "Find the port-forwarding section",
      body: `Look for ${info.menuPath}.`,
    },
    {
      heading: "Create the rule",
      body: `Create a new rule with: external port ${params.externalPort}, internal port ${params.internalPort}, protocol ${protocol}, and the internal address set to this Loombre server's own address on your local network (Settings → Server shows it, or check your operating system's network settings).${info.fieldNote ? ` ${info.fieldNote}` : ""}`,
    },
    {
      heading: "Save, and reboot if asked",
      body: "Save or apply the rule. If the router offers to reboot to apply it, let it — most don't need to, but a few older models do.",
    },
  ];
  return steps;
}

/** Builds the port-forwarding instruction card for one brand (or
 *  "generic"), parameterized by protocol/externalPort/internalPort so the
 *  SAME card content serves the Direct path (TCP 80/443) and the
 *  WireGuard path (its own UDP port) without duplicating a word of
 *  router-UI knowledge between them. */
export function buildPortForwardCard(brand: RouterBrandId, params: PortForwardParams): RouterCard {
  const protocol = protocolLabel(params.protocol);
  const brandLabel = ROUTER_BRAND_LABELS[brand];
  const isGeneric = brand === "generic";

  return {
    id: `port-forward-${brand}`,
    title: isGeneric ? "Forward a port on your router" : `Forward a port on your ${brandLabel} router`,
    intro: isGeneric
      ? `Opening a port tells your router "let this kind of traffic through to one specific device" — here, ${protocol} port ${params.externalPort} routed to this Loombre server. Loombre never uses UPnP or any other automatic router-configuration protocol to do this for you — you set it up here, once, so you always know exactly what's open on your network.`
      : `Opening a port tells your router "let this kind of traffic through to one specific device" — here, ${protocol} port ${params.externalPort} routed to this Loombre server. Menu names below match ${brandLabel}'s usual admin page; if yours looks different, your firmware version may use slightly different wording — the underlying steps are the same.`,
    steps: isGeneric ? genericPortForwardSteps(params) : brandPortForwardSteps(brand, params),
    diagram: {
      label: "Port-forwarding rule form",
      description: `A screenshot of the router's port-forwarding form, filled in with external port ${params.externalPort}, internal port ${params.internalPort}, protocol ${protocol}, and this Loombre server's local address — showing exactly what the finished rule should look like before saving.`,
    },
  };
}

// ============================================================================
// WAN address — where to read it (RG11 feed) + the CGNAT plain-language line
// ============================================================================

interface WanAddressBrandInfo {
  addressHint: string;
  signInHint: string;
  /** Where the WAN/Internet address is shown, in this brand's own wording. */
  statusLocation: string;
}

const WAN_ADDRESS_BRAND_INFO: Readonly<Record<Exclude<RouterBrandId, "generic">, WanAddressBrandInfo>> = {
  "tp-link": {
    addressHint: "tplinkwifi.net, or 192.168.0.1 / 192.168.1.1",
    signInHint: "the admin username and password printed on the router's label, unless you changed them",
    statusLocation: 'the "Status" page (some newer firmware: "Network Map"), under the "Internet" or "WAN" section',
  },
  netgear: {
    addressHint: "192.168.1.1, or routerlogin.net",
    signInHint: "the admin username and password printed on the router's label, unless you changed them",
    statusLocation: 'the "Basic Home" page (the first page after signing in), in the "Internet Port" box\'s "IP Address" field',
  },
  asus: {
    addressHint: "192.168.1.1, or router.asus.com",
    signInHint: "the admin username and password printed on the router's label, unless you changed them",
    statusLocation: '"Network Map" (the default page after signing in) — click the WAN/Internet icon to see the address',
  },
  linksys: {
    addressHint: "192.168.1.1, or myrouter.local on newer app-managed models",
    signInHint: "the admin username and password you set when the router was first configured",
    statusLocation: 'the "Connectivity" → "Basic" page\'s Internet/WAN summary',
  },
  fritzbox: {
    addressHint: "fritz.box, or 192.168.178.1",
    signInHint: "the FRITZ!Box password you set when the router was first configured (there is no separate username)",
    statusLocation: 'the "Overview" page\'s Internet connection summary, under "IPv4 address"',
  },
  unifi: {
    addressHint: "the UniFi Network application (a phone or desktop app, or a web console)",
    signInHint: "your UniFi account, the same one used to set up the network",
    statusLocation: '"Settings" → "Internet", where your uplink\'s WAN IP address is shown',
  },
};

/** Appears at the end of every WAN-address card, brand or generic (RG11):
 *  the ONE plain-language line that lets an admin self-diagnose carrier-
 *  grade NAT from the number itself, without needing to understand what
 *  CGNAT means first. */
const CGNAT_EXPLAINER =
  "Does that address start with a number from 100.64 through 100.127 (for example 100.87.4.20)? " +
  "That's not really your own address — it belongs to your internet provider's own shared address " +
  "space, sitting between you and the internet. No router setting can open a port past it; the " +
  "wizard will suggest the Tunnel path instead when it sees this.";

function genericWanAddressSteps(): readonly RouterCardStep[] {
  return [
    {
      heading: "Find your router's address",
      body: "On a device connected to your home network, open a web browser and type your router's address into the address bar — often something like 192.168.0.1 or 192.168.1.1. Check the label on the router itself, or look up \"default gateway\" in your device's network settings if you're not sure.",
    },
    {
      heading: "Sign in",
      body: "Sign in with the router's admin username and password — often printed on a sticker on the router itself, or whatever you set when it was first configured.",
    },
    {
      heading: "Find the Internet / WAN status page",
      body: 'Look for a page called something like "Status", "Internet", or "WAN" — it lists the address your internet connection itself uses (as opposed to the addresses it hands out to devices on your own network).',
    },
    {
      heading: "Read the address",
      body: `${CGNAT_EXPLAINER} Otherwise, enter the address exactly as shown into the wizard.`,
    },
  ];
}

function brandWanAddressSteps(brand: Exclude<RouterBrandId, "generic">): readonly RouterCardStep[] {
  const info = WAN_ADDRESS_BRAND_INFO[brand];
  return [
    {
      heading: "Find your router's address",
      body: `On a device connected to your home network, open a web browser and go to ${info.addressHint}.`,
    },
    {
      heading: "Sign in",
      body: `Sign in with ${info.signInHint}.`,
    },
    {
      heading: "Find the Internet / WAN status page",
      body: `Look for ${info.statusLocation} — it lists the address your internet connection itself uses (as opposed to the addresses it hands out to devices on your own network).`,
    },
    {
      heading: "Read the address",
      body: `${CGNAT_EXPLAINER} Otherwise, enter the address exactly as shown into the wizard.`,
    },
  ];
}

/** Builds the WAN-address-reading card for one brand (or "generic") — RG11:
 *  feeds the Direct path's CGNAT/reachability diagnosis, which needs an
 *  admin-supplied WAN address because no third-party echo service or
 *  router API exists anywhere in this codebase (R9's hard line). Not
 *  parameterized (reading an address involves no port/protocol choice). */
export function buildWanAddressCard(brand: RouterBrandId): RouterCard {
  const brandLabel = ROUTER_BRAND_LABELS[brand];
  const isGeneric = brand === "generic";

  return {
    id: `wan-address-${brand}`,
    title: isGeneric ? "Find your router's internet address" : `Find your ${brandLabel} router's internet address`,
    intro:
      "Your router shows the address your internet connection itself uses on its own status page — reading it here is how the setup wizard tells a simple port-forwarding problem apart from a network your internet provider won't let you open a port on at all.",
    steps: isGeneric ? genericWanAddressSteps() : brandWanAddressSteps(brand),
    diagram: {
      label: "Router internet-status page",
      description: isGeneric
        ? "A screenshot of a router's Internet/WAN status page, with the address field circled or highlighted."
        : `A screenshot of ${brandLabel}'s Internet/WAN status page, with the address field circled or highlighted.`,
    },
  };
}
