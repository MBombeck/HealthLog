import { describe, expect, it } from "vitest";

import { MeasurementType } from "@/generated/prisma/client";
import {
  EVENT_MEASUREMENT_TYPES,
  STATE_MEASUREMENT_TYPES,
} from "@/lib/validations/measurement";
import {
  ALLOWED_CHART_TOKENS,
  parseChartTokens,
  stripChartTokens,
  tokenToMetric,
} from "../chart-tokens";

describe("parseChartTokens", () => {
  it("extracts a single allowlisted token", () => {
    expect(
      parseChartTokens("Dein BP ist top metric:BLOOD_PRESSURE_SYS"),
    ).toEqual(["metric:BLOOD_PRESSURE_SYS"]);
  });

  it("drops tokens that are not on the allowlist", () => {
    expect(parseChartTokens("metric:NUKE will not render")).toEqual([]);
  });

  it("strips trailing junk via the regex character class", () => {
    // The greedy [A-Z_]+ class stops at the apostrophe, so the surviving
    // token is just `metric:WEIGHT` and the rest stays inert text.
    expect(parseChartTokens("metric:WEIGHT' onclick='alert(1)'")).toEqual([
      "metric:WEIGHT",
    ]);
  });

  it("returns multiple tokens preserving order", () => {
    expect(
      parseChartTokens(
        "metric:WEIGHT and metric:PULSE and a fake metric:NUKE here",
      ),
    ).toEqual(["metric:WEIGHT", "metric:PULSE"]);
  });

  it("returns [] for empty input", () => {
    expect(parseChartTokens("")).toEqual([]);
    expect(parseChartTokens("no tokens here")).toEqual([]);
  });
});

describe("stripChartTokens", () => {
  it("removes a token and collapses surrounding whitespace", () => {
    expect(stripChartTokens("BP top metric:BLOOD_PRESSURE_SYS now")).toBe(
      "BP top now",
    );
  });

  it("removes hallucinated tokens too — they are still well-formed", () => {
    expect(stripChartTokens("metric:NUKE try this")).toBe("try this");
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripChartTokens(" metric:WEIGHT ")).toBe("");
  });

  // v1.4.17 — defensive: reading `insight.summary` on a legacy
  // cached payload (no `summary` field) returns undefined. Crashing
  // with `Cannot read properties of undefined (reading 'replace')` was
  // the production /insights bug the maintainer hit on 2026-05-10. Treat
  // null/undefined as the empty string instead.
  it("returns empty string for undefined input", () => {
    expect(stripChartTokens(undefined)).toBe("");
  });

  it("returns empty string for null input", () => {
    expect(stripChartTokens(null)).toBe("");
  });
});

// v1.4.25 — the maintainer reported the raw "Metric Pressure_Sys" leak on
// /insights 2026-05-14. The v1.4.22 W1a regex only caught the canonical
// `metric:<TYPE>` colon form; the model emitted a capitalised "Metric"
// word followed by a Pascal/enum-cased identifier. The fix extends the
// stripper with two additional matchers: (1) `Metric <Word>` capitalised
// phrase, (2) bare upper-snake-case enum identifiers from the
// MeasurementType list (including the v1.4.23 Apple-Health additions).
describe("stripChartTokens — v1.4.25 W5b capitalised + orphan-enum leaks", () => {
  it("strips the capitalised `Metric Pressure_Sys` phrase the maintainer reported", () => {
    expect(
      stripChartTokens("Your Metric Pressure_Sys is sitting above 140."),
    ).toBe("Your is sitting above 140.");
  });

  it("strips the capitalised form with snake_case enum body", () => {
    expect(
      stripChartTokens("trend points up for Metric BLOOD_PRESSURE_SYS today"),
    ).toBe("trend points up for today");
  });

  it("strips orphan enum mentions in prose — BLOOD_PRESSURE_SYS", () => {
    expect(
      stripChartTokens("Your BLOOD_PRESSURE_SYS reading is elevated."),
    ).toBe("Your reading is elevated.");
  });

  it("strips orphan enum mentions — WEIGHT bare upper-snake-case is left alone", () => {
    // The bare word `WEIGHT` is shared with the user-facing metric
    // label, so the orphan-enum stripper deliberately allowlists it
    // against the user-facing label. Only suffixed enums (e.g.
    // BLOOD_PRESSURE_SYS) get cleaved.
    expect(stripChartTokens("Your WEIGHT trend is stable.")).toBe(
      "Your WEIGHT trend is stable.",
    );
  });

  it("strips orphan enum mentions — PULSE_BPM", () => {
    expect(stripChartTokens("PULSE_BPM stays within target.")).toBe(
      "stays within target.",
    );
  });

  it("strips orphan enum mentions — MOOD_SCORE", () => {
    expect(stripChartTokens("MOOD_SCORE drifted down this week.")).toBe(
      "drifted down this week.",
    );
  });

  it("strips orphan enum mentions — MEDICATION_COMPLIANCE_PCT", () => {
    expect(stripChartTokens("MEDICATION_COMPLIANCE_PCT held above 90.")).toBe(
      "held above 90.",
    );
  });

  it("strips v1.4.23 Apple Health additions — HEART_RATE_VARIABILITY", () => {
    expect(
      stripChartTokens("Last week HEART_RATE_VARIABILITY trended up."),
    ).toBe("Last week trended up.");
  });

  it("strips v1.4.23 Apple Health additions — RESTING_HEART_RATE", () => {
    expect(
      stripChartTokens("Your RESTING_HEART_RATE is stable around 58 bpm."),
    ).toBe("Your is stable around 58 bpm.");
  });

  it("strips v1.4.23 Apple Health additions — ACTIVE_ENERGY_BURNED", () => {
    expect(
      stripChartTokens("ACTIVE_ENERGY_BURNED has been below target."),
    ).toBe("has been below target.");
  });

  it("strips v1.4.23 Apple Health additions — FLIGHTS_CLIMBED, WALKING_RUNNING_DISTANCE, VO2_MAX, BODY_TEMPERATURE, SLEEP_DURATION", () => {
    expect(stripChartTokens("FLIGHTS_CLIMBED at 5/day.")).toBe("at 5/day.");
    expect(stripChartTokens("WALKING_RUNNING_DISTANCE averaged 4 km.")).toBe(
      "averaged 4 km.",
    );
    expect(stripChartTokens("VO2_MAX has crept up.")).toBe("has crept up.");
    expect(stripChartTokens("BODY_TEMPERATURE sat at 36.8 most days.")).toBe(
      "sat at 36.8 most days.",
    );
    expect(stripChartTokens("SLEEP_DURATION averaged 7.4h.")).toBe(
      "averaged 7.4h.",
    );
  });

  it("strips the Metric phrase + the enum together (defence in depth)", () => {
    // The model can emit both forms in the same sentence — the
    // capitalised phrase AND the bare enum identifier. Both pattern
    // matchers run independently so each cleaves its own substring.
    expect(
      stripChartTokens(
        "Metric BLOOD_PRESSURE_SYS shows your BLOOD_PRESSURE_SYS is elevated.",
      ),
    ).toBe("shows your is elevated.");
  });

  it("does not strip ordinary prose that incidentally contains 'metric' as a word", () => {
    // Lower-case word "metric" without the colon form must not be
    // touched — it's a perfectly legitimate English word inside copy
    // like "Each metric in the snapshot ...". The maintainer's directive
    // explicitly targets the leak patterns, not legitimate prose.
    expect(stripChartTokens("Each metric tells part of the story.")).toBe(
      "Each metric tells part of the story.",
    );
  });

  it("does not strip the canonical Metrik token in German prose", () => {
    // German prose uses "Metrik" (capitalised noun) freely; the
    // English-targeted `Metric <Word>` matcher must not bleed into
    // German copy. The regex is anchored to the literal English
    // word "Metric" + whitespace + identifier so "Metrik" is safe.
    expect(stripChartTokens("Jede Metrik liefert ein Stück.")).toBe(
      "Jede Metrik liefert ein Stück.",
    );
  });
});

describe("parseChartTokens — defensive (v1.4.17)", () => {
  it("returns empty array for undefined input", () => {
    expect(parseChartTokens(undefined)).toEqual([]);
  });

  it("returns empty array for null input", () => {
    expect(parseChartTokens(null)).toEqual([]);
  });
});

describe("tokenToMetric", () => {
  it("strips the `metric:` prefix", () => {
    expect(tokenToMetric("metric:WEIGHT")).toBe("WEIGHT");
    expect(tokenToMetric("metric:BLOOD_PRESSURE_SYS")).toBe(
      "BLOOD_PRESSURE_SYS",
    );
  });
});

describe("ALLOWED_CHART_TOKENS — drift guard", () => {
  it("has unique entries", () => {
    expect(new Set(ALLOWED_CHART_TOKENS).size).toBe(
      ALLOWED_CHART_TOKENS.length,
    );
  });

  it("covers every chartable MeasurementType enum value", () => {
    // If a future schema migration adds a new MeasurementType, this test
    // fails until the new `metric:<TYPE>` is also added to the allowlist.
    // (`NOTE` is excluded if it ever appears — currently the schema has none.)
    //
    // v1.10.0 — the categorical EVENT classes (irregular-rhythm /
    // high-low-HR / walking-steadiness / breathing-disturbance) are
    // deliberately NOT chartable: they are discrete device-flagged
    // occurrences with no continuous series, surfaced on the awareness
    // timeline rather than the inline chart renderer. They carry no
    // `metric:<TYPE>` token by design.
    const enumTokens = (Object.values(MeasurementType) as string[])
      .filter((value) => value !== "NOTE")
      .filter((value) => !EVENT_MEASUREMENT_TYPES.has(value))
      .filter((value) => !STATE_MEASUREMENT_TYPES.has(value))
      .map((value) => `metric:${value}`);

    for (const token of enumTokens) {
      expect(ALLOWED_CHART_TOKENS, `missing ${token}`).toContain(token);
    }
  });

  it("charts no category state as a numeric line", () => {
    // A codepoint (menopause 1, perimenopause 2, none 3) drawn as a line
    // reads as a trend that is not there.
    for (const type of STATE_MEASUREMENT_TYPES) {
      expect(ALLOWED_CHART_TOKENS).not.toContain(`metric:${type}`);
    }
    expect([...STATE_MEASUREMENT_TYPES].sort()).toEqual([
      "BLEEDING_AFTER_MENOPAUSE",
      "MENOPAUSAL_STATE",
    ]);
  });

  it("includes metric:MOOD now that <MoodChart> is wired into the renderer", () => {
    // v1.4.3 enabled `metric:MOOD`. The chart-token renderer branches
    // on `tokenKind(token) === "mood"` and mounts the dedicated,
    // self-fetching `<MoodChart>` instead of the generic `<HealthChart>`
    // (which Zod-validates against `measurementTypeEnum` and would
    // silently render empty).
    expect(ALLOWED_CHART_TOKENS).toContain("metric:MOOD");
  });

  it("excludes metric:COMPLIANCE because no self-fetching wrapper exists yet", () => {
    // `<ComplianceLineChart>` requires pre-aggregated daily data via
    // props; without a self-fetching wrapper the AI's inline rendering
    // would silently empty out. Land in v1.5 once the wrapper exists.
    expect(ALLOWED_CHART_TOKENS).not.toContain("metric:COMPLIANCE");
  });
});

describe("orphan-enum stripping stays coupled to the allowlist", () => {
  // `ORPHAN_ENUMS` used to be a hand-maintained literal and drifted every time
  // `ALLOWED_CHART_TOKENS` grew — by v1.30 eighteen allowlisted metrics had no
  // strip entry, so the raw enum leaked into rendered prose. It is now derived;
  // this guard is what keeps it derived.
  const PROSE_SAFE = new Set(["WEIGHT", "PULSE", "MOOD", "RESILIENCE"]);

  it.each(
    ALLOWED_CHART_TOKENS.map((t) => t.replace(/^metric:/, "")).filter(
      (name) => !PROSE_SAFE.has(name),
    ),
  )("strips the bare enum %s out of prose", (name) => {
    const stripped = stripChartTokens(`Your ${name} is elevated.`);
    expect(stripped).not.toContain(name);
  });

  it.each([...PROSE_SAFE])(
    "leaves the prose-safe single word %s alone",
    (word) => {
      expect(stripChartTokens(`Your ${word} trend is stable.`)).toContain(word);
    },
  );

  // The tokens the drift actually leaked, named so a regression is legible.
  it.each([
    "PHQ9_SCORE",
    "GAD7_SCORE",
    "WHO5_SCORE",
    "SCI_SCORE",
    "GRIP_STRENGTH",
    "CARDIO_LOAD",
    "ANS_CHARGE",
    "BODY_FAT",
    "BLOOD_GLUCOSE",
    "OXYGEN_SATURATION",
  ])("strips %s, which the stale literal list had missed", (name) => {
    expect(stripChartTokens(`Your ${name} is elevated.`)).not.toContain(name);
  });
});
