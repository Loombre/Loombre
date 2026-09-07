// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Linux GPU device-node inventory + access check for the hardware
 * capability self-test (docs/PLAYBACK.md §8.1).
 *
 * Why this exists: every hardware backend the battery tests on Linux opens
 * a device node — Intel Quick Sync and VAAPI a DRM render node
 * (/dev/dri/renderD*, group `render`/`video`, mode 0660), NVENC the
 * /dev/nvidia* nodes (world-accessible, but only present once the driver
 * and, for CUDA, the nvidia_uvm module are loaded). A service account
 * outside those groups, or a driver that never loaded, produces exactly
 * the same battery outcome as "no such GPU": every test FAILs, the report
 * says software-only, and nothing anywhere says WHY — the field report
 * that motivated this was a box with an Intel iGPU and an RTX card whose
 * self-test reported neither. This module answers the why:
 *
 *   1. `describeLinuxAccelDevices()` lists the nodes with their PCI vendor
 *      (from sysfs) and whether THIS process can open them read+write;
 *   2. `deviceAccessHints()` turns that into actionable operator lines
 *      (which group to join, which module to load) — logged by the hwprobe
 *      job and printed by the operator script;
 *   3. `formatDeviceAccessSummary()` is a stable text rendering that
 *      fingerprint.ts folds into the GPU fingerprint, so an access change
 *      (the account joined `render`; the NVIDIA driver got installed)
 *      invalidates the snapshot and the next worker boot re-probes on its
 *      own — the alternative, a stale software-only snapshot that survives
 *      the fix forever, is what the invalidation mechanism exists to
 *      prevent.
 *
 * All filesystem access goes through an injected `LinuxDeviceFs` so the
 * unit tests drive every branch with a fake tree, the same way battery.ts
 * takes an injected CommandRunner. Never throws: a missing /dev/dri or
 * /sys entry is data ("no such device"), not an error.
 */
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";

export type AccelDeviceKind = "drm-render" | "drm-card" | "nvidia";
export type AccelDeviceAccess = "rw" | "denied";

export interface AccelDeviceNode {
  /** Absolute device-node path, e.g. /dev/dri/renderD128. */
  path: string;
  kind: AccelDeviceKind;
  /** PCI vendor id as sysfs reports it ("0x8086"), null when unknown (no
   *  sysfs entry — every /dev/nvidia* node, or a virtual DRM device). */
  vendorId: string | null;
  /** Human vendor name for the known ids, else null. */
  vendor: string | null;
  access: AccelDeviceAccess;
  /** Owning group name of the node when resolvable (the hint names it). */
  group: string | null;
}

export interface LinuxDeviceFs {
  /** Directory entry names; [] when the directory does not exist. */
  readdir(dir: string): string[];
  /** File text; null when unreadable/absent. */
  readText(path: string): string | null;
  /** True iff the current process may open `path` for read AND write. */
  canReadWrite(path: string): boolean;
  /** Numeric gid of the path, null when unstat-able. */
  gidOf(path: string): number | null;
}

const PCI_VENDOR_NAMES: Record<string, string> = {
  "0x8086": "Intel",
  "0x10de": "NVIDIA",
  "0x1002": "AMD",
};

const DRI_DIR = "/dev/dri";
const DEV_DIR = "/dev";
const ETC_GROUP = "/etc/group";

export function createRealLinuxDeviceFs(): LinuxDeviceFs {
  return {
    readdir(dir) {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    readText(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    canReadWrite(path) {
      try {
        accessSync(path, constants.R_OK | constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    gidOf(path) {
      try {
        return statSync(path).gid;
      } catch {
        return null;
      }
    },
  };
}

function groupNameForGid(fs: LinuxDeviceFs, gid: number | null): string | null {
  if (gid === null) return null;
  const text = fs.readText(ETC_GROUP);
  if (text === null) return null;
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split(":");
    if (Number.parseInt(fields[2] ?? "", 10) === gid) return fields[0] ?? null;
  }
  return null;
}

function describeNode(fs: LinuxDeviceFs, path: string, kind: AccelDeviceKind, sysfsName: string | null): AccelDeviceNode {
  const vendorRaw = sysfsName === null ? null : fs.readText(`/sys/class/drm/${sysfsName}/device/vendor`);
  const vendorId = vendorRaw === null ? null : vendorRaw.trim().toLowerCase() || null;
  return {
    path,
    kind,
    vendorId,
    vendor: vendorId === null ? null : (PCI_VENDOR_NAMES[vendorId] ?? null),
    access: fs.canReadWrite(path) ? "rw" : "denied",
    group: groupNameForGid(fs, fs.gidOf(path)),
  };
}

/**
 * Every DRM render/card node plus every /dev/nvidia* node, in a stable
 * (sorted) order. Empty on a host with none — a VM, a container without
 * device passthrough — which the caller treats as "nothing to hint about".
 */
export function describeLinuxAccelDevices(fs: LinuxDeviceFs = createRealLinuxDeviceFs()): AccelDeviceNode[] {
  const nodes: AccelDeviceNode[] = [];
  for (const name of [...fs.readdir(DRI_DIR)].sort()) {
    if (name.startsWith("renderD")) nodes.push(describeNode(fs, `${DRI_DIR}/${name}`, "drm-render", name));
    else if (/^card\d+$/.test(name)) nodes.push(describeNode(fs, `${DRI_DIR}/${name}`, "drm-card", name));
  }
  for (const name of [...fs.readdir(DEV_DIR)].sort()) {
    if (/^nvidia(ctl|-uvm|-uvm-tools|-modeset|\d+)$/.test(name)) nodes.push(describeNode(fs, `${DEV_DIR}/${name}`, "nvidia", null));
  }
  return nodes;
}

/** One line per node — `path kind vendor access` — the text the GPU
 *  fingerprint hashes alongside lspci's output. Group names are deliberately
 *  NOT part of it (a group rename is not a capability change). */
export function formatDeviceAccessSummary(devices: readonly AccelDeviceNode[]): string {
  return devices.map((d) => `${d.path} ${d.kind} ${d.vendorId ?? "-"} ${d.access}`).join("\n");
}

export interface DeviceHintOptions {
  /** The account the worker runs as — named in the usermod hint. */
  user: string;
}

/**
 * Operator-facing explanations for the outcomes the battery is about to
 * produce, in the order the platform tries backends (qsv/vaapi first, then
 * nvenc). Empty when there is nothing to say (every node accessible, or no
 * accelerator hardware present at all).
 */
export function deviceAccessHints(devices: readonly AccelDeviceNode[], opts: DeviceHintOptions): string[] {
  const hints: string[] = [];
  const renderNodes = devices.filter((d) => d.kind === "drm-render");
  const deniedRender = renderNodes.filter((d) => d.access === "denied");
  if (renderNodes.length > 0 && deniedRender.length === renderNodes.length) {
    const groups = [...new Set(deniedRender.map((d) => d.group).filter((g): g is string => g !== null))];
    const vendors = [...new Set(deniedRender.map((d) => d.vendor ?? d.vendorId ?? "unknown vendor"))].join(", ");
    const joinCmd = groups.length > 0 ? `sudo usermod -aG ${groups.join(",")} ${opts.user}` : `sudo usermod -aG render,video ${opts.user}`;
    hints.push(
      `no DRM render node is accessible to this process (${deniedRender.map((d) => d.path).join(", ")}; ${vendors}): ` +
        `Intel Quick Sync and VAAPI cannot work until the '${opts.user}' account joins the node's group — run \`${joinCmd}\`, then restart loombre-worker (the self-test re-runs by itself).`,
    );
  } else {
    for (const d of deniedRender) {
      hints.push(`${d.path} (${d.vendor ?? d.vendorId ?? "unknown vendor"}) is not accessible to this process${d.group ? ` — add '${opts.user}' to group '${d.group}'` : ""}.`);
    }
  }

  const nvidiaPci = devices.some((d) => d.kind !== "nvidia" && d.vendorId === "0x10de");
  const nvidiaNodes = devices.filter((d) => d.kind === "nvidia");
  const hasCtl = nvidiaNodes.some((d) => d.path === "/dev/nvidiactl");
  const hasUvm = nvidiaNodes.some((d) => d.path === "/dev/nvidia-uvm");
  if (nvidiaPci && !hasCtl) {
    hints.push("an NVIDIA GPU is present but /dev/nvidiactl is missing — the proprietary NVIDIA driver is not loaded, so NVENC/CUDA are unavailable.");
  } else if (hasCtl && !hasUvm) {
    hints.push(
      "/dev/nvidia-uvm is missing — CUDA (NVENC's decode/tone-map side) needs the nvidia_uvm module, and the service's NoNewPrivileges sandbox cannot auto-load it: " +
        "add `nvidia_uvm` to /etc/modules-load.d/nvidia-uvm.conf (or `sudo modprobe nvidia_uvm`), then restart loombre-worker.",
    );
  }
  for (const d of nvidiaNodes.filter((n) => n.access === "denied" && /nvidia(ctl|\d+|-uvm)$/.test(n.path))) {
    hints.push(`${d.path} is not accessible to this process${d.group ? ` (group '${d.group}')` : ""} — NVIDIA nodes are normally 0666; check udev rules or the unit's DeviceAllow=.`);
  }
  return hints;
}
