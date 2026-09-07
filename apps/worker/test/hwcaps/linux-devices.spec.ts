// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  describeLinuxAccelDevices,
  deviceAccessHints,
  formatDeviceAccessSummary,
  type LinuxDeviceFs,
} from "../../src/hwcaps/linux-devices.js";

interface FakeTree {
  dirs: Record<string, string[]>;
  files: Record<string, string>;
  rw: Set<string>;
  gids: Record<string, number>;
}

function fakeFs(tree: FakeTree): LinuxDeviceFs {
  return {
    readdir: (dir) => tree.dirs[dir] ?? [],
    readText: (path) => tree.files[path] ?? null,
    canReadWrite: (path) => tree.rw.has(path),
    gidOf: (path) => tree.gids[path] ?? null,
  };
}

const ETC_GROUP = "root:x:0:\nvideo:x:39:\nrender:x:107:\nloombre:x:450:\n";

/** The field box: Intel iGPU on renderD128 (i915), RTX card on renderD129,
 *  NVIDIA nodes 0666, service account outside render/video. */
function fieldBox(overrides: Partial<FakeTree> = {}): FakeTree {
  return {
    dirs: {
      "/dev/dri": ["card0", "card1", "renderD128", "renderD129", "by-path"],
      "/dev": ["nvidia0", "nvidiactl", "nvidia-modeset", "nvidia-uvm", "nvidia-uvm-tools", "null", "dri"],
    },
    files: {
      "/etc/group": ETC_GROUP,
      "/sys/class/drm/renderD128/device/vendor": "0x8086\n",
      "/sys/class/drm/renderD129/device/vendor": "0x10de\n",
      "/sys/class/drm/card0/device/vendor": "0x8086\n",
      "/sys/class/drm/card1/device/vendor": "0x10de\n",
    },
    rw: new Set(["/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-modeset", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools"]),
    gids: {
      "/dev/dri/renderD128": 107,
      "/dev/dri/renderD129": 107,
      "/dev/dri/card0": 39,
      "/dev/dri/card1": 39,
      "/dev/nvidiactl": 0,
      "/dev/nvidia0": 0,
      "/dev/nvidia-uvm": 0,
    },
    ...overrides,
  };
}

describe("describeLinuxAccelDevices", () => {
  it("lists render + card nodes with sysfs vendors and every /dev/nvidia* node, sorted, with per-node access + group", () => {
    const devices = describeLinuxAccelDevices(fakeFs(fieldBox()));
    expect(devices.map((d) => d.path)).toEqual([
      "/dev/dri/card0",
      "/dev/dri/card1",
      "/dev/dri/renderD128",
      "/dev/dri/renderD129",
      "/dev/nvidia-modeset",
      "/dev/nvidia-uvm",
      "/dev/nvidia-uvm-tools",
      "/dev/nvidia0",
      "/dev/nvidiactl",
    ]);
    const render128 = devices.find((d) => d.path === "/dev/dri/renderD128")!;
    expect(render128).toEqual({ path: "/dev/dri/renderD128", kind: "drm-render", vendorId: "0x8086", vendor: "Intel", access: "denied", group: "render" });
    const render129 = devices.find((d) => d.path === "/dev/dri/renderD129")!;
    expect(render129.vendor).toBe("NVIDIA");
    expect(devices.find((d) => d.path === "/dev/nvidiactl")).toEqual({ path: "/dev/nvidiactl", kind: "nvidia", vendorId: null, vendor: null, access: "rw", group: "root" });
    expect(devices.find((d) => d.path === "/dev/dri/card0")!.kind).toBe("drm-card");
  });

  it("is empty on a host with no /dev/dri and no NVIDIA nodes (VM/container) — never throws", () => {
    expect(describeLinuxAccelDevices(fakeFs({ dirs: {}, files: {}, rw: new Set(), gids: {} }))).toEqual([]);
  });

  it("an unknown vendor id is carried verbatim with a null name; a missing sysfs entry yields null ids", () => {
    const tree = fieldBox();
    tree.files["/sys/class/drm/renderD128/device/vendor"] = "0x1af4\n";
    delete tree.files["/sys/class/drm/renderD129/device/vendor"];
    const devices = describeLinuxAccelDevices(fakeFs(tree));
    expect(devices.find((d) => d.path === "/dev/dri/renderD128")).toMatchObject({ vendorId: "0x1af4", vendor: null });
    expect(devices.find((d) => d.path === "/dev/dri/renderD129")).toMatchObject({ vendorId: null, vendor: null });
  });
});

describe("formatDeviceAccessSummary", () => {
  it("renders one stable line per node (path, kind, vendor id, access) and omits group names", () => {
    const summary = formatDeviceAccessSummary(describeLinuxAccelDevices(fakeFs(fieldBox())));
    expect(summary.split("\n")).toContain("/dev/dri/renderD128 drm-render 0x8086 denied");
    expect(summary.split("\n")).toContain("/dev/nvidiactl nvidia - rw");
    expect(summary).not.toMatch(/render:|root:/);
  });

  it("changes when access changes (the invalidation trigger) and is empty for no devices", () => {
    const before = formatDeviceAccessSummary(describeLinuxAccelDevices(fakeFs(fieldBox())));
    const fixed = fieldBox();
    fixed.rw.add("/dev/dri/renderD128");
    fixed.rw.add("/dev/dri/renderD129");
    const after = formatDeviceAccessSummary(describeLinuxAccelDevices(fakeFs(fixed)));
    expect(after).not.toBe(before);
    expect(formatDeviceAccessSummary([])).toBe("");
  });
});

describe("deviceAccessHints", () => {
  it("field box: every render node denied -> ONE hint naming the vendors, the node's group, the usermod command and the account; NVIDIA needs nothing", () => {
    const hints = deviceAccessHints(describeLinuxAccelDevices(fakeFs(fieldBox())), { user: "loombre" });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/no DRM render node is accessible/);
    expect(hints[0]).toMatch(/Intel, NVIDIA/);
    expect(hints[0]).toMatch(/`sudo usermod -aG render loombre`/);
    expect(hints[0]).toMatch(/restart loombre-worker/);
  });

  it("nothing to say once the render nodes are accessible", () => {
    const fixed = fieldBox();
    fixed.rw.add("/dev/dri/renderD128");
    fixed.rw.add("/dev/dri/renderD129");
    expect(deviceAccessHints(describeLinuxAccelDevices(fakeFs(fixed)), { user: "loombre" })).toEqual([]);
  });

  it("a partially denied set hints per node rather than with the blanket message", () => {
    const partial = fieldBox();
    partial.rw.add("/dev/dri/renderD128");
    const hints = deviceAccessHints(describeLinuxAccelDevices(fakeFs(partial)), { user: "loombre" });
    expect(hints).toEqual(["/dev/dri/renderD129 (NVIDIA) is not accessible to this process — add 'loombre' to group 'render'."]);
  });

  it("falls back to render,video in the command when the node's group cannot be resolved", () => {
    const tree = fieldBox();
    delete tree.files["/etc/group"];
    const hints = deviceAccessHints(describeLinuxAccelDevices(fakeFs(tree)), { user: "loombre" });
    expect(hints[0]).toMatch(/`sudo usermod -aG render,video loombre`/);
  });

  it("NVIDIA GPU on the PCI bus but no /dev/nvidiactl -> driver-not-loaded hint", () => {
    const tree = fieldBox({ dirs: { "/dev/dri": ["renderD128", "renderD129"], "/dev": ["null"] } });
    tree.rw.add("/dev/dri/renderD128");
    tree.rw.add("/dev/dri/renderD129");
    const hints = deviceAccessHints(describeLinuxAccelDevices(fakeFs(tree)), { user: "loombre" });
    expect(hints).toEqual(["an NVIDIA GPU is present but /dev/nvidiactl is missing — the proprietary NVIDIA driver is not loaded, so NVENC/CUDA are unavailable."]);
  });

  it("/dev/nvidiactl present but /dev/nvidia-uvm absent -> the nvidia_uvm modules-load hint (NoNewPrivileges blocks the setuid loader)", () => {
    const tree = fieldBox({ dirs: { "/dev/dri": ["renderD128"], "/dev": ["nvidia0", "nvidiactl"] } });
    tree.rw.add("/dev/dri/renderD128");
    const hints = deviceAccessHints(describeLinuxAccelDevices(fakeFs(tree)), { user: "loombre" });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/\/dev\/nvidia-uvm is missing/);
    expect(hints[0]).toMatch(/modules-load\.d\/nvidia-uvm\.conf/);
  });

  it("an NVIDIA node that is not accessible is called out (udev / DeviceAllow)", () => {
    const tree = fieldBox();
    tree.rw.add("/dev/dri/renderD128");
    tree.rw.add("/dev/dri/renderD129");
    tree.rw.delete("/dev/nvidiactl");
    const hints = deviceAccessHints(describeLinuxAccelDevices(fakeFs(tree)), { user: "loombre" });
    expect(hints).toEqual(["/dev/nvidiactl is not accessible to this process (group 'root') — NVIDIA nodes are normally 0666; check udev rules or the unit's DeviceAllow=."]);
  });

  it("no accelerator hardware at all -> no hints", () => {
    expect(deviceAccessHints([], { user: "loombre" })).toEqual([]);
  });
});
