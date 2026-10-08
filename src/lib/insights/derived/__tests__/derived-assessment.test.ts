import { describe, it, expect } from "vitest";
import {
  resolveDeterministicAssessment,
  buildScoreSignal,
  isAssessableDerivedScore,
  ASSESSABLE_DERIVED_SCORES,
} from "@/lib/insights/derived/derived-assessment";
import type { Derived } from "@/lib/insights/derived/types";
import type { ReadinessValue } from "@/lib/insights/derived/readiness";
import type { SleepScoreValue } from "@/lib/insights/derived/sleep-score";
import type { WellnessScoreValue } from "@/lib/insights/derived/wellness-scores";

const NOW = new Date("2026-06-05T12:00:00Z");

function okDerived<T>(value: T): Derived<T> {
  return {
    status: "ok",
    value,
    coverage: {
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 30,
      missing: [],
    },
    confidence: { score: 90, band: "high" },
    provenance: {
      inputs: ["X"],
      source: "DAY",
      windowDays: 30,
      computedAt: NOW.toISOString(),
    },
  };
}

const insufficient: Derived<unknown> = {
  status: "insufficient",
  coverage: {
    requiredInputs: 1,
    presentInputs: 0,
    historyDays: 0,
    missing: ["X"],
  },
  provenance: {
    inputs: ["X"],
    source: "none",
    windowDays: 0,
    computedAt: NOW.toISOString(),
  },
  reason: "no_score_in_window",
};

const readiness: ReadinessValue = {
  score: 64,
  band: "yellow",
  components: [
    { key: "rhr", value: 40, weight: 0.3 },
    { key: "hrv", value: 80, weight: 0.3 },
    { key: "sleep", value: 70, weight: 0.25 },
    { key: "respiratory", value: null, weight: 0 },
    { key: "mood", value: 60, weight: 0.15 },
  ],
};

const sleepScore: SleepScoreValue = {
  score: 82,
  band: "green",
  night: "2026-06-04",
  asleepMinutes: 440,
  inBedMinutes: 470,
  subScores: [
    { key: "sufficiency", value: 95, weight: 0.3 },
    { key: "efficiency", value: 90, weight: 0.25 },
    { key: "consistency", value: 70, weight: 0.2 },
    { key: "timing", value: 80, weight: 0.1 },
    { key: "composition", value: 88, weight: 0.15 },
  ],
  windowNights: 20,
  series: [78, 82],
};

const recovery: WellnessScoreValue = {
  score: 55,
  band: "yellow",
  trendDelta: -8,
  daysInWindow: 12,
  asOf: NOW.toISOString(),
  series: [60, 58, 55],
};

describe("assessable derived scores", () => {
  it("is exactly the five iOS ids", () => {
    expect([...ASSESSABLE_DERIVED_SCORES].sort()).toEqual([
      "READINESS",
      "RECOVERY_SCORE",
      "SLEEP_SCORE",
      "STRAIN_SCORE",
      "STRESS_SCORE",
    ]);
    expect(isAssessableDerivedScore("READINESS")).toBe(true);
    expect(isAssessableDerivedScore("BMI")).toBe(false);
  });
});

describe("resolveDeterministicAssessment", () => {
  it("returns null for a non-assessable metric", () => {
    expect(
      resolveDeterministicAssessment(
        "BMI",
        okDerived({ score: 50, band: "green" }),
        "en",
        NOW,
      ),
    ).toBeNull();
  });

  it("returns null when status !== ok (the locked contract)", () => {
    expect(
      resolveDeterministicAssessment("READINESS", insufficient, "en", NOW),
    ).toBeNull();
  });

  it("always fills a non-empty deterministic text for an ok score", () => {
    const a = resolveDeterministicAssessment(
      "READINESS",
      okDerived(readiness),
      "en",
      NOW,
    );
    expect(a).not.toBeNull();
    expect(a!.source).toBe("deterministic");
    expect(a!.text.length).toBeGreaterThan(0);
    expect(a!.updatedAt).toBe(NOW.toISOString());
  });

  it("names the score and the weakest contributors for a yellow readiness (en)", () => {
    const a = resolveDeterministicAssessment(
      "READINESS",
      okDerived(readiness),
      "en",
      NOW,
    );
    expect(a!.text).toContain("64 out of 100");
    // rhr (40) is the lowest present contributor → mentioned.
    expect(a!.text.toLowerCase()).toContain("resting heart rate");
    // never references the null (respiratory) contributor.
    expect(a!.text.toLowerCase()).not.toContain("respiratory");
  });

  it("affirms the strongest contributor for a green sleep score (de)", () => {
    const a = resolveDeterministicAssessment(
      "SLEEP_SCORE",
      okDerived(sleepScore),
      "de",
      NOW,
    );
    expect(a!.text).toContain("82 von 100");
    expect(a!.text).toContain("im guten Bereich");
    // sufficiency (95) is the strongest → affirmed for a green band.
    expect(a!.text).toContain("Schlafmenge");
  });

  it("appends a grounded next step when the weakest contributor is addressable (en)", () => {
    // sleep (30) is the lowest present contributor → a behaviourally
    // addressable driver, so the assessment closes with a doable pointer.
    const sleepWeak: ReadinessValue = {
      score: 58,
      band: "yellow",
      components: [
        { key: "rhr", value: 80, weight: 0.3 },
        { key: "hrv", value: 75, weight: 0.3 },
        { key: "sleep", value: 30, weight: 0.25 },
        { key: "mood", value: 70, weight: 0.15 },
      ],
    };
    const a = resolveDeterministicAssessment(
      "READINESS",
      okDerived(sleepWeak),
      "en",
      NOW,
    );
    expect(a!.text).toContain("Held back most by");
    expect(a!.text).toContain("An earlier night would lift this most.");
  });

  it("does NOT manufacture a step when the weakest contributor is physiology-only (en)", () => {
    // rhr (40) is the lowest in the base readiness fixture → no pointer.
    const a = resolveDeterministicAssessment(
      "READINESS",
      okDerived(readiness),
      "en",
      NOW,
    );
    expect(a!.text).not.toContain("An earlier night");
    expect(a!.text).not.toContain("most effective lever");
  });

  it("uses the trend for a contributor-less recovery score (en)", () => {
    const a = resolveDeterministicAssessment(
      "RECOVERY_SCORE",
      okDerived(recovery),
      "en",
      NOW,
    );
    expect(a!.text).toContain("55 out of 100");
    // trendDelta -8 → "8 points lower".
    expect(a!.text).toContain("−8 points lower");
  });
});

// v1.22 (W6) — the deterministic fallback now closes with a band-conditioned
// "what it means for today" read (a closed table; no number introduced), so the
// provider-less + demo score cards carry the forward interpretation too.
describe("band → meaning enrichment (deterministic fallback)", () => {
  it("appends the forward read for a yellow readiness (en)", () => {
    const a = resolveDeterministicAssessment(
      "READINESS",
      okDerived(readiness),
      "en",
      NOW,
    );
    expect(a!.text).toContain("usual load");
  });

  it("appends the forward read for a green sleep score (en)", () => {
    const a = resolveDeterministicAssessment(
      "SLEEP_SCORE",
      okDerived(sleepScore),
      "en",
      NOW,
    );
    expect(a!.text.toLowerCase()).toContain("carry you well");
  });

  // v1.28.40 — the band-meaning read now OPENS the assessment (verdict-first)
  // instead of closing it, so the score card leads with meaning, e.g.
  // "A middling day … — your readiness is 64/100 …".
  it("leads with the band-meaning verdict BEFORE the score standing (en)", () => {
    const a = resolveDeterministicAssessment(
      "READINESS",
      okDerived(readiness),
      "en",
      NOW,
    );
    // Yellow readiness meaning ("… usual load …") precedes the "64 out of 100".
    expect(a!.text.indexOf("usual load")).toBeGreaterThanOrEqual(0);
    expect(a!.text.indexOf("usual load")).toBeLessThan(
      a!.text.indexOf("out of 100"),
    );
  });

  it("names BOTH a carry (green) AND the forward read (de)", () => {
    const a = resolveDeterministicAssessment(
      "SLEEP_SCORE",
      okDerived(sleepScore),
      "de",
      NOW,
    );
    // green branch names the strongest contributor as the carry …
    expect(a!.text).toContain("Getragen vor allem von");
    // … and the closed band-meaning table appends the forward read.
    expect(a!.text).toContain("durch den Tag tragen");
  });
});

describe("buildScoreSignal", () => {
  it("carries contributors for READINESS", () => {
    const signal = buildScoreSignal("READINESS", readiness, "en");
    expect(signal!.current).toBe(64);
    expect(signal!.contributors).toHaveLength(5);
    expect(signal!.metric).toBe("your readiness");
  });

  it("derives a signed delta from trendDelta for RECOVERY", () => {
    const signal = buildScoreSignal("RECOVERY_SCORE", recovery, "en");
    expect(signal!.current).toBe(55);
    expect(signal!.baseline).toBe(63); // 55 - (-8)
    expect(signal!.delta).toBe(-8);
    expect(signal!.direction).toBe("higher-better");
  });

  it("frames stress/strain as lower-better", () => {
    const strain = buildScoreSignal("STRAIN_SCORE", recovery, "en");
    expect(strain!.direction).toBe("lower-better");
  });
});
