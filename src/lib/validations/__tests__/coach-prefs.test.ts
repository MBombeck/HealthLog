import { describe, expect, it } from "vitest";

import {
  DEFAULT_COACH_CLUSTERS,
  DEFAULT_COACH_PREFS,
  coachPrefsSchema,
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

  it("falls back to defaults when dataClusters carries an unknown cluster", () => {
    // Shape drift — an unknown cluster string fails the enum, the whole
    // parse fails, and parseCoachPrefs returns the legacy defaults
    // (dataClusters undefined → legacy cluster expansion).
    const out = parseCoachPrefs({ dataClusters: ["cardio", "astrology"] });
    expect(out).toEqual(DEFAULT_COACH_PREFS);
    expect(out.dataClusters).toBeUndefined();
  });

  it("DEFAULT_COACH_CLUSTERS preserves the legacy five domains' clusters", () => {
    expect([...DEFAULT_COACH_CLUSTERS].sort()).toEqual([
      "body",
      "cardio",
      "medication",
      "mood",
    ]);
  });
});
