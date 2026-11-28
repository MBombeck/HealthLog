/**
 * v1.34.5 — the route from the blood-pressure score to its reason.
 *
 * A pillar reading 56 gave no way to find out why: the popover held the
 * reference band, the personal target and the source, and nothing said
 * which of the two axes had set the number, how far over its ceiling that
 * axis sat, or that a reading exactly at the ceiling reads 85 rather than
 * 100. These pin the three lines that answer it, in the two locales the
 * maintainer reads, against the real bundles.
 *
 * The lines live behind a Radix popover, which only mounts once opened,
 * so they are asserted through the pure formatter the card feeds it —
 * the same strings the card shows, not a second copy of the copy.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, useTranslations } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import type { BpScoreBasis } from "@/lib/analytics/bp-grade";
import type { ScorePillarResult } from "@/lib/analytics/score/types";
import {
  pillarDetailLines,
  type Translate,
} from "../health-score-pillar-detail";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

function translator(locale: Locale = "en"): Translate {
  let captured: Translate | null = null;
  function Probe() {
    captured = useTranslations().t;
    return null;
  }
  renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <Probe />
    </I18nProvider>,
  );
  if (!captured) throw new Error("translator probe did not run");
  return captured;
}

function bloodPressure(scoreBasis?: BpScoreBasis): ScorePillarResult {
  return {
    id: "BLOOD_PRESSURE",
    domain: "cardiometabolic",
    result: {
      status: "ok",
      value: {
        score: 56,
        ...(scoreBasis ? { scoreBasis } : {}),
        observed: {
          value: 137,
          unit: "mmHg",
          label: "137/87\u00a0mmHg",
          asOf: "2026-07-30T08:00:00.000Z",
          sources: ["MANUAL"],
        },
        reference: {
          kind: "clinical-threshold",
          low: 120,
          high: 129,
          label: "120 to 129/70 to 79\u00a0mmHg",
          source: "ESH 2023",
        },
        noiseFloor: 1,
        deltaEligible: true,
        deltaIdentity: "graded_bp_pair_series",
      },
      coverage: {
        requiredInputs: 12,
        presentInputs: 12,
        historyDays: 60,
        missing: [],
      },
      confidence: { score: 100, band: "high" },
      provenance: {
        inputs: ["BLOOD_PRESSURE"],
        source: "live",
        windowDays: 90,
        computedAt: "2026-07-30T12:00:00.000Z",
      },
    },
  };
}

const ABOVE_CEILING: BpScoreBasis = {
  axis: "systolic",
  relation: "above_ceiling",
  offsetMmHg: 8,
  boundaryMmHg: 129,
};

describe("blood-pressure score basis in the popover", () => {
  it("leads with the binding axis, its distance and its ceiling", () => {
    const lines = pillarDetailLines(bloodPressure(ABOVE_CEILING), {
      t: translator(),
      glucoseUnit: "mg/dL",
    });
    expect(lines[0]).toBe(
      "Systolic sets this score: about 8\u00a0mmHg over its ceiling of 129\u00a0mmHg.",
    );
  });

  it("names the diastolic axis when that is the one that bound", () => {
    const lines = pillarDetailLines(
      bloodPressure({
        axis: "diastolic",
        relation: "above_ceiling",
        offsetMmHg: 9,
        boundaryMmHg: 79,
      }),
      { t: translator(), glucoseUnit: "mg/dL" },
    );
    expect(lines[0]).toBe(
      "Diastolic sets this score: about 9\u00a0mmHg over its ceiling of 79\u00a0mmHg.",
    );
  });

  it("measures a hypotensive reading from the low-pressure floor", () => {
    const lines = pillarDetailLines(
      bloodPressure({
        axis: "systolic",
        relation: "below_floor",
        offsetMmHg: 4,
        boundaryMmHg: 90,
      }),
      { t: translator(), glucoseUnit: "mg/dL" },
    );
    expect(lines[0]).toBe(
      "Systolic sets this score: about 4\u00a0mmHg under the low-pressure floor of 90\u00a0mmHg.",
    );
  });

  it("says both axes are in band without naming a distance", () => {
    const lines = pillarDetailLines(
      bloodPressure({
        axis: "systolic",
        relation: "in_band",
        offsetMmHg: 5,
        boundaryMmHg: 129,
      }),
      { t: translator(), glucoseUnit: "mg/dL" },
    );
    expect(lines[0]).toBe(
      "Both values are at or below their reference ceilings.",
    );
  });

  it("explains the scale and the averaged reading, then the shipped lines", () => {
    const lines = pillarDetailLines(bloodPressure(ABOVE_CEILING), {
      t: translator(),
      glucoseUnit: "mg/dL",
    });
    expect(lines[1]).toBe(
      "At the ceiling the score is 85; 100 means roughly 12\u00a0mmHg below it.",
    );
    // The window comes off the pillar's own provenance, so the sentence
    // cannot drift from the window the score was actually read over.
    expect(lines[2]).toBe(
      "Based on a recency-weighted average of the last 90 days, so it may not match any single reading.",
    );
    expect(lines).toHaveLength(5);
    expect(lines[3]).toContain("ESH 2023");
    expect(lines[4]).toContain("Source: MANUAL");
  });

  it("reads in German too", () => {
    const lines = pillarDetailLines(bloodPressure(ABOVE_CEILING), {
      t: translator("de"),
      glucoseUnit: "mg/dL",
    });
    expect(lines[0]).toBe(
      "Ausschlaggebend: Systolisch, etwa 8\u00a0mmHg über der Obergrenze von 129\u00a0mmHg.",
    );
    expect(lines[1]).toBe(
      "An der Obergrenze liegt der Wert bei 85; 100 bedeutet rund 12\u00a0mmHg darunter.",
    );
    expect(lines[2]).toBe(
      "Beruht auf einem Durchschnitt der letzten 90 Tage, der neuere Messungen stärker gewichtet, und kann deshalb von jeder einzelnen Messung abweichen.",
    );
  });

  it("says nothing at all when the server published no basis", () => {
    // The field is optional and blood-pressure-only: an older payload, or
    // a pillar that has nothing of the kind to say, must fall back to the
    // shipped lines rather than to an empty or invented sentence.
    const lines = pillarDetailLines(bloodPressure(), {
      t: translator(),
      glucoseUnit: "mg/dL",
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ESH 2023");
    expect(lines.join("\n")).not.toContain("mmHg over its ceiling");
  });

  it("leaves other pillars untouched", () => {
    const glycaemia: ScorePillarResult = {
      ...bloodPressure(ABOVE_CEILING),
      id: "GLYCAEMIA",
    };
    const lines = pillarDetailLines(glycaemia, {
      t: translator(),
      glucoseUnit: "mg/dL",
    });
    expect(lines.join("\n")).not.toContain("sets this score");
    expect(lines.join("\n")).not.toContain("At the ceiling");
  });
});
