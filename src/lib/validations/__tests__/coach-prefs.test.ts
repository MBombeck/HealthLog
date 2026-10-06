import { describe, expect, it } from "vitest";

import {
  DEFAULT_COACH_CLUSTERS,
  DEFAULT_COACH_PREFS,
  coachPrefsSchema,
  coachReasoningLevel,
  parseCoachPrefs,
} from "../coach-prefs";

/**
 * v1.4.23 H4 — per-user Coach prompt-tuning preferences.
 */
describe("coachPrefsSchema", () => {
  it("accepts an empty object and fills in defaults", () => {
    const out = coachPrefsSchema.parse({});
    expect(out).toEqual(DEFAULT_COACH_PREFS);
  });

  it("accepts the full shape and round-trips it", () => {
    const input = {
      tone: "concise" as const,
      verbosity: "brief" as const,
      excludeMetrics: ["bp", "weight"] as const,
      showEvidenceByDefault: true,
      defaultWindow: "last30days" as const,
    };
    const out = coachPrefsSchema.parse(input);
    expect(out).toEqual(input);
  });

  // v1.4.25 W5 — defaultWindow added. Missing key → fallback to
  // "allTime" so the legacy persisted shape stays representative.
  it("fills in defaultWindow=allTime when the key is missing", () => {
    const out = coachPrefsSchema.parse({});
    expect(out.defaultWindow).toBe("allTime");
  });

  it("rejects unknown defaultWindow values", () => {
    const result = coachPrefsSchema.safeParse({ defaultWindow: "lifetime" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown tone values", () => {
    const result = coachPrefsSchema.safeParse({ tone: "stoic" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown verbosity values", () => {
    const result = coachPrefsSchema.safeParse({ verbosity: "rambling" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown excludeMetrics entries", () => {
    const result = coachPrefsSchema.safeParse({
      excludeMetrics: ["bp", "horoscope"],
    });
    expect(result.success).toBe(false);
  });

  it("caps excludeMetrics at 11 entries", () => {
    // v1.4.36 W3 T2 — cap raised from 9 to 11 to admit the two new
    // optional-context toggles (medications, anthropometrics).
    const result = coachPrefsSchema.safeParse({
      excludeMetrics: [
        "bp",
        "weight",
        "pulse",
        "mood",
        "compliance",
        "hrv",
        "sleep",
        "resting_hr",
        "steps",
        "medications",
        "anthropometrics",
        "bp",
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts the new medications + anthropometrics tokens", () => {
    const out = coachPrefsSchema.parse({
      excludeMetrics: ["medications", "anthropometrics"],
    });
    expect(out.excludeMetrics).toEqual(["medications", "anthropometrics"]);
  });
});

describe("parseCoachPrefs", () => {
  it("returns defaults for null input", () => {
    expect(parseCoachPrefs(null)).toEqual(DEFAULT_COACH_PREFS);
  });

  it("returns defaults for undefined input", () => {
    expect(parseCoachPrefs(undefined)).toEqual(DEFAULT_COACH_PREFS);
  });

  it("returns defaults for malformed input (forward-compat fallback)", () => {
    expect(parseCoachPrefs({ tone: "stoic" })).toEqual(DEFAULT_COACH_PREFS);
    expect(parseCoachPrefs("not an object")).toEqual(DEFAULT_COACH_PREFS);
  });

  it("preserves a valid shape", () => {
    const input = {
      tone: "neutral" as const,
      verbosity: "default" as const,
      excludeMetrics: ["mood" as const],
      showEvidenceByDefault: true,
      defaultWindow: "last90days" as const,
    };
    expect(parseCoachPrefs(input)).toEqual(input);
  });

  it("fills defaultWindow=allTime when older persisted rows are missing it", () => {
    // Legacy v1.4.23/v1.4.24 persisted shape without `defaultWindow`.
    // Defaulting is backwards-compatible — the row keeps reading as
    // "all time" until the user picks a tighter default in the cog.
    const legacy = {
      tone: "warm" as const,
      verbosity: "default" as const,
      excludeMetrics: [] as const,
      showEvidenceByDefault: false,
    };
    expect(parseCoachPrefs(legacy).defaultWindow).toBe("allTime");
  });

  // ── v1.7.0 dataClusters ──
  it("leaves dataClusters undefined for legacy rows (back-compat sentinel)", () => {
    // A row persisted before v1.7.0 has no `dataClusters` key. The
    // field must stay `undefined` so the snapshot builder expands the
    // legacy default cluster set rather than an empty array.
    const legacy = {
      tone: "warm" as const,
      verbosity: "default" as const,
      excludeMetrics: [] as const,
      showEvidenceByDefault: false,
      defaultWindow: "allTime" as const,
    };
    expect(parseCoachPrefs(legacy).dataClusters).toBeUndefined();
    expect(parseCoachPrefs(null).dataClusters).toBeUndefined();
    expect(parseCoachPrefs({}).dataClusters).toBeUndefined();
  });

  it("round-trips an explicit dataClusters array", () => {
    const out = parseCoachPrefs({
      dataClusters: ["cardio", "glucose", "workouts"],
    });
    expect(out.dataClusters).toEqual(["cardio", "glucose", "workouts"]);
  });

  it("honours an explicit empty dataClusters array as everything-off", () => {
    const out = coachPrefsSchema.parse({ dataClusters: [] });
    expect(out.dataClusters).toEqual([]);
  });

  it("keeps the known clusters when dataClusters carries an unknown one", () => {
    // Shape drift: a cluster a newer version added. Falling back to the
    // legacy default set would widen what the Coach reads past what the
    // person chose; dropping only the unknown entry narrows it.
    const out = parseCoachPrefs({ dataClusters: ["cardio", "astrology"] });
    expect(out.dataClusters).toEqual(["cardio"]);
  });

  it("lets an invalid field fall back alone and keeps the exclusions", () => {
    // A window value this version does not know (written by a newer one,
    // read after a rollback) must not take the metric exclusions with it.
    const out = parseCoachPrefs({
      tone: "neutral",
      defaultWindow: "lastDecade",
      excludeMetrics: ["mood", "weight"],
    });
    expect(out.defaultWindow).toBe("allTime");
    expect(out.excludeMetrics).toEqual(["mood", "weight"]);
    expect(out.tone).toBe("neutral");
  });

  it("keeps the known exclusions when the list carries an unknown metric", () => {
    const out = parseCoachPrefs({ excludeMetrics: ["mood", "aura"] });
    expect(out.excludeMetrics).toEqual(["mood"]);
  });

  it("DEFAULT_COACH_CLUSTERS preserves the legacy five domains' clusters", () => {
    expect([...DEFAULT_COACH_CLUSTERS].sort()).toEqual([
      "body",
      "cardio",
      "medication",
      "mood",
    ]);
  });

  // v1.18.1 (Workstream C) — reminder-suggestion sub-shape.
  it("a legacy blob (no reminderSuggestions) parses with the key absent", () => {
    const out = parseCoachPrefs({ tone: "warm" });
    expect(out.reminderSuggestions).toBeUndefined();
  });

  it("fills the reminderSuggestions defaults when the key is an empty object", () => {
    const out = coachPrefsSchema.parse({ reminderSuggestions: {} });
    expect(out.reminderSuggestions).toEqual({
      enabled: true,
      stopped: false,
      dismissedCadences: [],
      lastSuggestedAt: null,
    });
  });

  it("round-trips a populated reminderSuggestions block", () => {
    const out = coachPrefsSchema.parse({
      reminderSuggestions: {
        enabled: true,
        stopped: false,
        dismissedCadences: ["bp_7_2_2"],
        lastSuggestedAt: "2026-06-16T12:00:00.000Z",
      },
    });
    expect(out.reminderSuggestions?.dismissedCadences).toEqual(["bp_7_2_2"]);
    expect(out.reminderSuggestions?.lastSuggestedAt).toBe(
      "2026-06-16T12:00:00.000Z",
    );
  });
});

describe("reasoning (v1.41)", () => {
  it("is absent on a legacy blob and reads as medium", () => {
    const prefs = parseCoachPrefs({ tone: "neutral" });
    expect(prefs).not.toHaveProperty("reasoning");
    expect(coachReasoningLevel(prefs)).toBe("medium");
    expect(coachReasoningLevel(DEFAULT_COACH_PREFS)).toBe("medium");
  });

  it.each(["off", "low", "medium", "high"] as const)(
    "round-trips %s",
    (level) => {
      const prefs = parseCoachPrefs({ reasoning: level });
      expect(prefs.reasoning).toBe(level);
      expect(coachReasoningLevel(prefs)).toBe(level);
    },
  );

  it("rejects an unknown level on write", () => {
    expect(coachPrefsSchema.safeParse({ reasoning: "max" }).success).toBe(
      false,
    );
  });

  it("drops an unknown stored level alone and keeps every other field", () => {
    const prefs = parseCoachPrefs({
      reasoning: "xhigh",
      tone: "concise",
      excludeMetrics: ["weight"],
    });
    expect(prefs.reasoning).toBeUndefined();
    expect(coachReasoningLevel(prefs)).toBe("medium");
    expect(prefs.tone).toBe("concise");
    expect(prefs.excludeMetrics).toEqual(["weight"]);
  });
});
