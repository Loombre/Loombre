// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  buildDecodeTestArgs,
  buildEncodeTestArgs,
  buildHdrSourceArgs,
  buildToneMapArgs,
  extensionForDecodeSource,
  extensionForEncodeTest,
  parseEncoderNames,
  resolveDecodeSourceEncoder,
  resolveEncoderName,
  resolveSoftwareAv1Encoder,
} from "../../src/hwcaps/args.js";

describe("buildDecodeTestArgs", () => {
  it("software: no -hwaccel, no -hwaccel_output_format at all", () => {
    const args = buildDecodeTestArgs("software", "/tmp/src.mp4");
    expect(args).not.toContain("-hwaccel");
    expect(args).not.toContain("-hwaccel_output_format");
    expect(args).toEqual(["-hide_banner", "-loglevel", "verbose", "-i", "/tmp/src.mp4", "-an", "-f", "null", "-"]);
  });

  it("videotoolbox: -hwaccel videotoolbox AND -hwaccel_output_format videotoolbox_vld — REQUIRED, not optional (real-machine finding, see tables.ts header)", () => {
    const args = buildDecodeTestArgs("videotoolbox", "/tmp/src.mp4");
    expect(args).toContain("-hwaccel");
    expect(args[args.indexOf("-hwaccel") + 1]).toBe("videotoolbox");
    expect(args).toContain("-hwaccel_output_format");
    expect(args[args.indexOf("-hwaccel_output_format") + 1]).toBe("videotoolbox_vld");
  });

  it("d3d11va (decode-only backend): still gets -hwaccel, no output-format entry in the table (amf shares its raw hwaccel token but only amf itself is the encode-capable one)", () => {
    const args = buildDecodeTestArgs("d3d11va", "/tmp/src.mp4");
    expect(args).toContain("-hwaccel");
    expect(args[args.indexOf("-hwaccel") + 1]).toBe("d3d11va");
    expect(args).not.toContain("-hwaccel_output_format");
  });
});

describe("buildEncodeTestArgs", () => {
  it("software h264: ultrafast preset, no explicit bitrate", () => {
    const args = buildEncodeTestArgs("software", "h264", "libx264");
    expect(args).toContain("-preset");
    expect(args[args.indexOf("-preset") + 1]).toBe("ultrafast");
    expect(args).not.toContain("-b:v");
  });

  it("hardware backend: explicit bitrate, no software preset flag", () => {
    const args = buildEncodeTestArgs("nvenc", "h264", "h264_nvenc");
    expect(args).toContain("-b:v");
    expect(args).not.toContain("-preset");
  });

  it("software av1 via libsvtav1 uses -preset 12; via libaom-av1 uses -cpu-used 8", () => {
    expect(buildEncodeTestArgs("software", "av1", "libsvtav1")).toEqual(
      expect.arrayContaining(["-preset", "12"]),
    );
    expect(buildEncodeTestArgs("software", "av1", "libaom-av1")).toEqual(
      expect.arrayContaining(["-cpu-used", "8"]),
    );
  });
});

describe("buildToneMapArgs", () => {
  it("videotoolbox + 'videotoolbox' method: hwaccel+output-format+scale_vt filter+its own h264 encoder", () => {
    const args = buildToneMapArgs("videotoolbox", "videotoolbox", "/tmp/hdr.mkv");
    expect(args).toContain("-hwaccel");
    expect(args[args.indexOf("-hwaccel") + 1]).toBe("videotoolbox");
    expect(args).toContain("-hwaccel_output_format");
    expect(args[args.indexOf("-hwaccel_output_format") + 1]).toBe("videotoolbox_vld");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale_vt=color_matrix=bt709:color_primaries=bt709:color_transfer=bt709");
    expect(args[args.indexOf("-c:v") + 1]).toBe("h264_videotoolbox");
  });

  it("nvenc + 'cuda' method: tonemap_cuda filter, h264_nvenc verify encoder, explicit bitrate", () => {
    const args = buildToneMapArgs("nvenc", "cuda", "/tmp/hdr.mkv");
    expect(args[args.indexOf("-vf") + 1]).toBe("tonemap_cuda=format=yuv420p:tonemap=hable");
    expect(args[args.indexOf("-c:v") + 1]).toBe("h264_nvenc");
    expect(args).toContain("-b:v");
  });

  it("qsv + 'opencl'/'vulkan': correct filter string per method", () => {
    expect(buildToneMapArgs("qsv", "opencl", "/tmp/hdr.mkv")[buildToneMapArgs("qsv", "opencl", "/tmp/hdr.mkv").indexOf("-vf") + 1]).toBe(
      "tonemap_opencl=format=yuv420p:tonemap=hable",
    );
    expect(buildToneMapArgs("qsv", "vulkan", "/tmp/hdr.mkv")[buildToneMapArgs("qsv", "vulkan", "/tmp/hdr.mkv").indexOf("-vf") + 1]).toBe(
      "libplacebo=tonemapping=hable:format=yuv420p",
    );
  });
});

describe("buildHdrSourceArgs", () => {
  it("uses the zscale relabel-only filter (verified empirically to survive re-probe, unlike plain output-flag tagging)", () => {
    const args = buildHdrSourceArgs();
    const filter = args[args.indexOf("-vf") + 1]!;
    expect(filter).toContain("zscale=tin=smpte2084:t=smpte2084");
    expect(args).toContain("libx265");
  });
});

describe("extension helpers", () => {
  it("decode-test source extensions per codec", () => {
    expect(extensionForDecodeSource("h264")).toBe("mp4");
    expect(extensionForDecodeSource("hevc")).toBe("mp4");
    expect(extensionForDecodeSource("av1")).toBe("mkv");
    expect(extensionForDecodeSource("vp9")).toBe("webm");
    expect(extensionForDecodeSource("mpeg2")).toBe("ts");
  });

  it("encode-test output extensions: av1 -> mkv, everything else -> mp4", () => {
    expect(extensionForEncodeTest("h264")).toBe("mp4");
    expect(extensionForEncodeTest("hevc")).toBe("mp4");
    expect(extensionForEncodeTest("av1")).toBe("mkv");
  });
});

describe("resolveSoftwareAv1Encoder / resolveDecodeSourceEncoder / resolveEncoderName", () => {
  it("prefers libsvtav1 over libaom-av1 when both are present", () => {
    expect(resolveSoftwareAv1Encoder(new Set(["libsvtav1", "libaom-av1"]))).toBe("libsvtav1");
  });
  it("falls back to libaom-av1 when libsvtav1 is absent", () => {
    expect(resolveSoftwareAv1Encoder(new Set(["libaom-av1"]))).toBe("libaom-av1");
  });
  it("null when neither is present", () => {
    expect(resolveSoftwareAv1Encoder(new Set())).toBeNull();
  });

  it("resolveDecodeSourceEncoder gates on real availability, not just table presence", () => {
    expect(resolveDecodeSourceEncoder("h264", new Set(["libx264"]))).toBe("libx264");
    expect(resolveDecodeSourceEncoder("h264", new Set())).toBeNull();
  });

  it("resolveEncoderName: videotoolbox has no av1 table entry regardless of encoders", () => {
    expect(resolveEncoderName("videotoolbox", "av1", new Set(["av1_videotoolbox"]))).toBeNull();
  });
  it("resolveEncoderName: nvenc av1 resolves when av1_nvenc is actually listed, null otherwise", () => {
    expect(resolveEncoderName("nvenc", "av1", new Set(["av1_nvenc"]))).toBe("av1_nvenc");
    expect(resolveEncoderName("nvenc", "av1", new Set())).toBeNull();
  });
});

describe("parseEncoderNames", () => {
  it("parses ffmpeg -encoders' fixed-width listing format", () => {
    const stdout = [
      "Encoders:",
      " V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)",
      " V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)",
      " A....D aac                  AAC (Advanced Audio Coding)",
    ].join("\n");
    const names = parseEncoderNames(stdout);
    expect(names.has("libx264")).toBe(true);
    expect(names.has("h264_videotoolbox")).toBe(true);
    expect(names.has("aac")).toBe(true);
    expect(names.has("Encoders:")).toBe(false);
  });
});
