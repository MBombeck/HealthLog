/**
 * The tile comparison tones and the deviation line, resolved once on the
 * server from the served bands.
 */
import { describe, expect, it } from "vitest";

import type { DataSummary } from "@/lib/analytics/trends";
import { buildDashboardBands } from "@/lib/dashboard/bands";
import {
  rangeTone,
  resolveTileComparison,
} from "@/lib/dashboard/tile-comparison";
import { getServerTranslator } from "@/lib/i18n/server-translator";

const RANGE = { greenMin: 60, greenMax: 80, orangeMin: 54, orangeMax: 86 };

const summary = (
  avg7: number | null,
  avg30: number | null,
  latest: number | null = avg7,
) => ({ count: 10, avg7, avg30, latest }) as unknown as DataSummary;

const bands = {
  ...buildDashboardBands({
    dateOfBirth: new Date("1980-01-01T00:00:00Z"),
    gender: "MALE",
    heightCm: 180,
    thresholdsJson: null,
    timezone: "Europe/Berlin",
  }),
  weightRange: RANGE,
  bpSysRange: { greenMin: 110, greenMax: 130, orangeMin: 104, orangeMax: 136 },
  bpDiaRange: { greenMin: 70, greenMax: 85, orangeMin: 65, orangeMax: 90 },
  pulseDisplayRange: RANGE,
};

const en = getServerTranslator("en").t;
const de = getServerTranslator("de").t;

describe("rangeTone", () => {
  it("places a value inside, in the wings and beyond, with its side", () => {
    expect(rangeTone(70, RANGE)).toEqual({ band: "good", side: null });
    expect(rangeTone(60, RANGE)).toEqual({ band: "good", side: null });
    expect(rangeTone(84, RANGE)).toEqual({ band: "fair", side: "above" });
    expect(rangeTone(55, RANGE)).toEqual({ band: "fair", side: "below" });
    expect(rangeTone(90, RANGE)).toEqual({ band: "low", side: "above" });
    expect(rangeTone(40, RANGE)).toEqual({ band: "low", side: "below" });
  });

  it("judges nothing without a value or a range", () => {
    expect(rangeTone(null, RANGE)).toEqual({ band: null, side: null });
    expect(rangeTone(70, null)).toEqual({ band: null, side: null });
  });
});

describe("resolveTileComparison", () => {
  it("serves the ranged tiles only, bp by the side further out", () => {
    const out = resolveTileComparison({
      summaries: {
        WEIGHT: summary(84, 70),
        BLOOD_PRESSURE_SYS: summary(120, 132),
        BLOOD_PRESSURE_DIA: summary(95, 80),
        RESTING_HEART_RATE: summary(null, 70),
        BODY_FAT: summary(20, 20),
      },
      bands,
      attention: {},
      t: en,
    });
    expect(Object.keys(out).sort()).toEqual(["bp", "pulse", "weight"]);
    expect(out.weight?.avg7).toEqual({ band: "fair", side: "above" });
    expect(out.weight?.avg30).toEqual({ band: "good", side: null });
    // avg7: sys inside, dia beyond, so dia; avg30: sys in the wings, dia
    // inside, so sys.
    expect(out.bp?.avg7).toEqual({ band: "low", side: "above" });
    expect(out.bp?.avg30).toEqual({ band: "fair", side: "above" });
    expect(out.pulse?.avg7).toEqual({ band: null, side: null });
  });

  it("leaves out a pulse tile without resting rows", () => {
    const out = resolveTileComparison({
      summaries: { PULSE: summary(100, 100) },
      bands,
      attention: {},
      t: en,
    });
    expect(out.pulse).toBeUndefined();
  });

  it("words the line only while the tile's attention is range", () => {
    const summaries = {
      WEIGHT: summary(84, 70, 84),
      RESTING_HEART_RATE: summary(70, 50, 50),
    };
    const out = resolveTileComparison({
      summaries,
      bands,
      attention: { weight: "range", pulse: "range" },
      t: de,
    });
    expect(out.weight?.line).toBe("Über dem Zielbereich");
    // avg7 is inside; the line names the latest value's side.
    expect(out.pulse?.line).toBe("Unter dem Zielbereich");

    const calm = resolveTileComparison({
      summaries,
      bands,
      attention: { weight: "change", pulse: "today" },
      t: en,
    });
    expect(calm.weight?.line).toBeNull();
    expect(calm.pulse?.line).toBeNull();
  });

  it("names the side of the latest value, not of the means", () => {
    const out = resolveTileComparison({
      // Latest is below the band while both means sit above it.
      summaries: { WEIGHT: summary(84, 84, 50) },
      bands,
      attention: { weight: "range" },
      t: en,
    });
    expect(out.weight?.avg7.side).toBe("above");
    expect(out.weight?.line).toBe("Below target range");
  });

  it("words a line when the latest value is out and both means are in", () => {
    const out = resolveTileComparison({
      summaries: { WEIGHT: summary(70, 70, 90) },
      bands,
      attention: { weight: "range" },
      t: en,
    });
    expect(out.weight?.line).toBe("Above target range");
  });

  it("serves no line when the latest value is inside the band", () => {
    const out = resolveTileComparison({
      summaries: { WEIGHT: summary(70, 70) },
      bands,
      attention: { weight: "range" },
      t: en,
    });
    expect(out.weight?.line).toBeNull();
  });

  it("words the line in English", () => {
    const out = resolveTileComparison({
      summaries: { WEIGHT: summary(40, 40) },
      bands,
      attention: { weight: "range" },
      t: en,
    });
    expect(out.weight?.line).toBe("Below target range");
  });
});
