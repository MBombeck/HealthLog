/**
 * Whose profile the dashboard's client-side band fallback is allowed to use.
 *
 * The fallback draws reference bands — blood-pressure targets, the weight
 * range, every shaded chart zone — from the profile the page already holds,
 * so that charts are not blank for the frames before the server-resolved
 * bands arrive. That profile comes from `/api/auth/me`, an actor surface, so
 * under an account switch it describes the DELEGATE while the charts underneath
 * carry the OWNER's readings. A band is a claim about the person whose numbers
 * it shades; borrowing one from the person looking is the same wrong-record
 * paint the RSC prefetch already had to be taught to avoid, and it is quieter,
 * because a shaded zone looks exactly as authoritative either way.
 *
 * These assert the emptiness has TEETH: the same profile that produces a real
 * band unswitched must produce none switched, so an implementation that
 * returned its input regardless fails on the second half of every case rather
 * than on a shape check.
 *
 * Mutation checks, run:
 *   - `return profile;` unconditionally in `viewerBandProfile` → the three
 *     switched cases go red, printing the delegate's own BP target numbers as
 *     the value that reached the band.
 */
import { describe, expect, it } from "vitest";

import { buildDashboardBands, viewerBandProfile } from "@/lib/dashboard/bands";

/** A delegate with a complete profile — the worst case, not the empty one. */
const DELEGATE_PROFILE = {
  dateOfBirth: new Date("1996-04-02T00:00:00Z"),
  gender: "FEMALE" as const,
  heightCm: 165,
  thresholdsJson: { WEIGHT: { min: 55, max: 62 } },
  timezone: "Europe/Berlin",
};

describe("viewerBandProfile", () => {
  it("hands the profile through untouched when nobody has switched", () => {
    expect(viewerBandProfile(DELEGATE_PROFILE, false)).toEqual(
      DELEGATE_PROFILE,
    );
  });

  it("answers with no profile facts at all while acting on another record", () => {
    expect(viewerBandProfile(DELEGATE_PROFILE, true)).toEqual({
      dateOfBirth: null,
      gender: null,
      heightCm: null,
      thresholdsJson: null,
      timezone: "Europe/Berlin",
    });
  });
});

describe("the bands that result", () => {
  it("are real for the caller's own dashboard", () => {
    // The evidence half. Without it, "no band under a switch" is satisfied by
    // a profile that never produced one.
    const own = buildDashboardBands(viewerBandProfile(DELEGATE_PROFILE, false));
    expect(own.bpTargets).not.toBeNull();
    expect(own.weightRange).not.toBeNull();
    expect(own.weightBands).not.toBeNull();
  });

  it("carry none of the caller's profile onto a record they are acting on", () => {
    const own = buildDashboardBands(viewerBandProfile(DELEGATE_PROFILE, false));
    const shared = buildDashboardBands(
      viewerBandProfile(DELEGATE_PROFILE, true),
    );

    expect(shared.bpTargets).toBeNull();
    expect(shared.bpSysRange).toBeNull();
    expect(shared.bpDiaRange).toBeNull();
    expect(shared.weightRange).toBeNull();
    expect(shared.weightBands).toBeNull();

    // The pulse and body-fat bands have no null arm — they fall back to the
    // published population range — so the claim there is that the numbers are
    // the NEUTRAL ones and not the ones this caller's age and sex produce.
    expect(shared.pulseDisplayRange).not.toEqual(own.pulseDisplayRange);
    expect(shared.bodyFatRange).not.toEqual(own.bodyFatRange);
  });
});
