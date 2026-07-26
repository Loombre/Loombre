#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Deterministic stand-in for the real ffprobe binary, used only by
 * ffprobe.spec.ts to exercise runFfprobe()'s spawn/timeout/exit-code/JSON
 * error handling without depending on a real ffprobe install (this repo's
 * CI runners don't provision ffmpeg — see probe.integration.spec.ts, which
 * skips cleanly instead). Behavior is selected via FAKE_FFPROBE_MODE:
 *   success  -> valid minimal RawProbeResult JSON on stdout, exit 0
 *   nonzero  -> stderr message, exit 3
 *   badjson  -> unparseable stdout, exit 0
 *   hang     -> never exits (for the timeout/SIGKILL path)
 */
const mode = process.env.FAKE_FFPROBE_MODE ?? "success";

switch (mode) {
  case "success": {
    const payload = {
      format: { format_name: "mp4", duration: "1.500000", size: "12345", bit_rate: "65840" },
      streams: [],
      chapters: [],
    };
    process.stdout.write(JSON.stringify(payload));
    process.exit(0);
    break;
  }
  case "nonzero": {
    process.stderr.write("fake-ffprobe: simulated probe failure\n");
    process.exit(3);
    break;
  }
  case "badjson": {
    process.stdout.write("{not valid json");
    process.exit(0);
    break;
  }
  case "hang": {
    setInterval(() => {}, 60_000);
    break;
  }
  default: {
    process.stderr.write(`fake-ffprobe: unknown FAKE_FFPROBE_MODE '${mode}'\n`);
    process.exit(2);
  }
}
