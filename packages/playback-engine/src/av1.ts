// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AV1 encode gate + demotion primitive (LD-7 / LD-16, docs/PLAYBACK.md
 * §7.1/§7.2). Wave C1.
 *
 * ONE rule, TWO consumers — the same structure `src/dv.ts` exists for, for
 * the same reason. `stages/ladder.ts` uses this module to decide whether
 * §7.1(f)'s AV1 swap may claim a rung and whether §7.1(g) must demote one;
 * `stages/hardware.ts` uses the SAME functions for §7.2's Stage-G residual
 * guard. Neither re-derives anything. That is not tidiness: LD-3's failure
 * class was two derivations of one fact drifting apart until a reason
 * claimed something the builder never did, and the LD-16 law is exactly the
 * kind of rule where a second, slightly-different copy would eventually
 * admit a Tier-0 software AV1 encode nobody intended.
 *
 * THE LAW (LD register, owner-adjudicated 2026-08-10, normative as
 * docs/PLAYBACK.md §7.2): AV1 on Tier-0 is permitted ONLY when supported
 * hardware encoding is verified by the probe battery; Tier-1 and above may
 * fall back to software AV1 encoding.
 *
 * WHY (the N100/4GB arithmetic, §7.2, restated because a future reader will
 * be tempted to relax this): SVT-AV1 at its realtime-band presets reaches
 * 1080p realtime on roughly 8 modern performance cores. Four Gracemont
 * E-cores deliver a small fraction of that — order 0.2-0.4× realtime, i.e.
 * a 6-second segment costs ~15-30 s to encode. §9's segment-ahead throttle
 * never engages because the encoder never GETS ahead; the playhead overruns
 * it inside the first minute and every playback stalls unrecoverably, with
 * all four cores pegged, starving Postgres/server/worker on the same 4 GB
 * box. A permanently-behind encoder is the worst possible violation of
 * design law 5, so the escape hatch is real hardware, not a checkbox.
 *
 * Pure: no I/O, no clock, no framework (docs/PLAYBACK.md §0 law 1).
 */
import type { PlanReason } from "./reasons.js";
import type { DeviceProfile, LadderRung, ServerPolicy, VerifiedCapabilities } from "./types.js";

/**
 * §7.1's AV1 swap factor (owner-decision D3, §7.4): the h264-baseline
 * bitrate-parity convention one generation past hevc's documented ×0.75.
 * Exported so `stages/ladder.ts` never carries a second literal.
 */
export const AV1_BITRATE_FACTOR = 0.6;

export type Av1EncodeEligibility = "hw" | "software" | "none";

/**
 * §7.2's single gate, verbatim:
 *   'hw'       iff some backend b with b.backend !== 'software' has 'av1'
 *              in b.encode;
 *   'software' iff not 'hw', AND tier >= 1, AND the software backend's OWN
 *              probe-verified encode list includes 'av1';
 *   'none'     otherwise.
 *
 * The `'software'` arm is itself capability-VERIFIED (design law 4): it
 * reads the software row's probe-verified encode list, which §8.1 only
 * populates when the bundled build's `libsvtav1` actually passed the encode
 * self-test on this box (§7.3's D4 narrowing — a box whose ffmpeg carries
 * only `libaom-av1` reports software-av1 encode ABSENT). "Software can av1"
 * is a tested fact here, never an assumption.
 *
 * NOTE what this function deliberately does NOT ask: whether the chosen
 * backend can cover the ladder's OTHER target codecs. That is §8.3's route
 * resolution, and the gap between "some hw backend can av1" and "the routed
 * backend can encode everything this ladder needs" is exactly what §7.2's
 * Stage-G residual guard closes (`stages/hardware.ts`).
 */
export function av1EncodeEligibility(caps: VerifiedCapabilities, tier: ServerPolicy["tier"]): Av1EncodeEligibility {
  for (const backend of caps.backends) {
    if (backend.backend !== "software" && backend.encode.includes("av1")) return "hw";
  }
  if (tier >= 1) {
    for (const backend of caps.backends) {
      if (backend.backend === "software" && backend.encode.includes("av1")) return "software";
    }
  }
  return "none";
}

/**
 * The `cause` half of §4's `av1-rung-demoted` detail. Three causes come
 * from the ladder's own normalization step (§7.1(g)); the fourth comes from
 * §7.2's Stage-G residual guard.
 */
export type Av1DemotionCause =
  | "tier0-no-hw-av1"
  | "device-no-av1"
  | "no-av1-encoder"
  | "tier0-software-route";

/** §7.1's condition 2, both halves. AV1 cannot ride `ts-hls` — it has no
 *  assigned MPEG-TS stream_type, so muxing it there produces a stream
 *  nothing standard can demux (§6 interpretation M) — which makes
 *  `device.hls.supportsFmp4` as much a part of "can this device take AV1"
 *  as the `device.video` entry itself. */
function deviceAdmitsAv1(device: DeviceProfile): boolean {
  if (!device.hls.supportsFmp4) return false;
  return device.video.some((entry) => entry.codec === "av1");
}

/**
 * §7.1's conditions 2 and 3, and NOTHING else — returns `null` when an av1
 * rung is admissible for this device/caps/tier, or the cause of its
 * demotion.
 *
 * Condition 1 (`policy.av1EncodePreferred`) is STRUCTURALLY ABSENT from
 * this function, not merely unchecked: §7.1(g) says an explicit
 * `policy.ladderRungs` av1 row IS the operator's preference for that rung,
 * so the global opt-in governs only the automatic swap. Taking no `policy`
 * argument at all is how that is enforced rather than remembered — the
 * function cannot consult a flag it was never handed. (`test/av1.spec.ts`
 * asserts the arity for exactly this reason.)
 *
 * CAUSE PRECEDENCE (interpretation, reported not silently chosen — §7.1
 * names the causes but not their order when several apply): the DEVICE
 * condition is evaluated first, because it is the one an operator cannot
 * fix by buying hardware; only then does the capability condition
 * distinguish the Tier-0 refusal (`tier0-no-hw-av1`) from "no av1 encoder
 * exists on this box at all" (`no-av1-encoder`).
 */
export function av1RungBlocker(
  device: DeviceProfile,
  caps: VerifiedCapabilities,
  tier: ServerPolicy["tier"],
): Av1DemotionCause | null {
  if (!deviceAdmitsAv1(device)) return "device-no-av1";
  if (av1EncodeEligibility(caps, tier) !== "none") return null;
  return tier === 0 ? "tier0-no-hw-av1" : "no-av1-encoder";
}

/**
 * §7.1(f)'s AV1 swap gate: the operator opt-in AND every condition an
 * explicit av1 rung would have to satisfy. Expressing it as
 * `flag && blocker === null` is what makes §7.1(g) a structural no-op for
 * swapped rungs — the swap cannot produce a rung the normalization step
 * would then demote, because it checked the identical predicate.
 */
export function av1SwapApplies(policy: ServerPolicy, device: DeviceProfile, caps: VerifiedCapabilities): boolean {
  if (!policy.av1EncodePreferred) return false;
  return av1RungBlocker(device, caps, policy.tier) === null;
}

/** One demotion that happened, in the shape §4's `detail` needs. */
export interface Av1Demotion {
  heightPx: number;
  demotedTo: "hevc" | "h264";
  cause: Av1DemotionCause;
}

/** §7.1(g): "codec becomes 'hevc' if `device.video` declares an hevc entry,
 *  else 'h264'". */
function demotionTarget(device: DeviceProfile): "hevc" | "h264" {
  return device.video.some((entry) => entry.codec === "hevc") ? "hevc" : "h264";
}

function sameRung(a: LadderRung, b: LadderRung): boolean {
  return (
    a.heightPx === b.heightPx &&
    a.videoBitrateBps === b.videoBitrateBps &&
    a.audioBitrateBps === b.audioBitrateBps &&
    a.codec === b.codec
  );
}

/**
 * THE SHARED DEMOTION PRIMITIVE (§7.1(g) + §7.2's Stage-G guard). Rewrites
 * every `av1` rung in `rungs` to `device`'s best available fallback codec,
 * keeping `heightPx`, `videoBitrateBps` and `audioBitrateBps` VERBATIM —
 * the admin chose those numbers, and inventing a scaled replacement would
 * be guessing (the ×0.6 swap factor is a statement about a rung the ENGINE
 * created, never about one it was given).
 *
 * DEMOTE, DON'T DROP: dropping could empty a configured ladder or silently
 * discard the admin's quality point; demotion keeps the rung count and
 * heights stable on every box, so a T0 admin who force-writes av1 rungs
 * gets the same ladder SHAPE encoded by the machine's real encoders — a
 * serveable plan, never a melted box.
 *
 * The one exception is duplication: "a demoted rung that becomes
 * field-identical to another table rung is dropped instead of duplicated"
 * (§7.1(g)). Implemented as: a demoted rung is dropped when an identical
 * rung exists anywhere else in the table that is either NOT itself a
 * demotion, or is an EARLIER demotion — so first occurrence wins and the
 * result is independent of which duplicate the admin listed first.
 * NON-demoted duplicates are left exactly as they were: a table that
 * already contained two identical rows keeps both, so no pre-C1 ladder can
 * change shape here.
 *
 * A demotion that is subsequently dropped as a duplicate STILL reports its
 * reason: the admin's av1 rung is gone either way, and the question
 * `av1-rung-demoted` exists to answer ("why is this rung not AV1?") is
 * about the rung they configured, not about the row that survived.
 */
export function demoteAv1Rungs(
  rungs: readonly LadderRung[],
  device: DeviceProfile,
  cause: Av1DemotionCause,
): { rungs: LadderRung[]; demotions: Av1Demotion[] } {
  if (!rungs.some((rung) => rung.codec === "av1")) {
    return { rungs: [...rungs], demotions: [] };
  }

  const demotedTo = demotionTarget(device);
  const rewritten = rungs.map((rung) =>
    rung.codec === "av1"
      ? {
          rung: {
            heightPx: rung.heightPx,
            videoBitrateBps: rung.videoBitrateBps,
            audioBitrateBps: rung.audioBitrateBps,
            codec: demotedTo,
          } satisfies LadderRung,
          wasDemoted: true,
        }
      : { rung, wasDemoted: false },
  );

  const out: LadderRung[] = [];
  const demotions: Av1Demotion[] = [];
  rewritten.forEach((entry, i) => {
    if (entry.wasDemoted) {
      demotions.push({ heightPx: entry.rung.heightPx, demotedTo, cause });
      const duplicate = rewritten.some(
        (other, j) => j !== i && sameRung(other.rung, entry.rung) && (!other.wasDemoted || j < i),
      );
      if (duplicate) return;
    }
    out.push(entry.rung);
  });

  return { rungs: out, demotions };
}

/**
 * The §4 reason for one demotion, formatted in ONE place so the ladder's
 * and Stage G's reasons cannot diverge in wording either. `detail` is
 * `cause=<...> demotedTo=<hevc|h264> heightPx=<n>` exactly as §4 documents.
 * No `streamIndex`: a demotion is a property of a ladder rung, not of a
 * source stream (same convention Stage A's container reason follows).
 */
export function av1DemotionReason(demotion: Av1Demotion): PlanReason {
  return {
    code: "av1-rung-demoted",
    detail: `cause=${demotion.cause} demotedTo=${demotion.demotedTo} heightPx=${demotion.heightPx}`,
  };
}
