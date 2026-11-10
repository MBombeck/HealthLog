import { describe, expect, it } from "vitest";

import { MGDL_PER_MMOL } from "@/lib/glucose";
import {
  GKI_PAIRING_WINDOW_MINUTES,
  glucoseKetoneIndex,
  pairGlucoseKetoneIndex,
  summariseGlucoseKetoneIndex,
  type GkiReading,
} from "@/lib/measurements/glucose-ketone-index";

const T0 = Date.parse("2026-11-01T08:00:00.000Z");
const MIN = 60_000;

function reading(
  id: string,
  offsetMin: number,
  value: number,
  source = "MANUAL",
): GkiReading {
  return { id, measuredAt: new Date(T0 + offsetMin * MIN), value, source };
}

describe("glucoseKetoneIndex", () => {
  it("divides glucose in mmol/L by ketones, converting with the one factor", () => {
    // 90 mg/dL = 4.995 mmol/L; over 1.5 mmol/L ketones.
    expect(glucoseKetoneIndex(90, 1.5)).toBeCloseTo(90 / MGDL_PER_MMOL / 1.5);
    expect(glucoseKetoneIndex(90, 1.5)).toBeCloseTo(3.33, 2);
  });

  it("has no index without ketones or with a value that is not positive", () => {
    expect(glucoseKetoneIndex(90, 0)).toBeNull();
    expect(glucoseKetoneIndex(90, -1)).toBeNull();
    expect(glucoseKetoneIndex(0, 1)).toBeNull();
    expect(glucoseKetoneIndex(Number.NaN, 1)).toBeNull();
    expect(glucoseKetoneIndex(90, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("pairGlucoseKetoneIndex", () => {
  it("pairs a fingerstick written with one timestamp", () => {
    const [point, ...rest] = pairGlucoseKetoneIndex(
      [reading("k1", 0, 1.2)],
      [reading("g1", 0, 81)],
    );
    expect(rest).toEqual([]);
    expect(point).toEqual({
      ketoneId: "k1",
      glucoseId: "g1",
      at: new Date(T0).toISOString(),
      glucoseAt: new Date(T0).toISOString(),
      // 81 / 18.0182 = 4.4954 mmol/L; / 1.2 = 3.746 -> 3.7
      value: 3.7,
      ketonesMmol: 1.2,
      glucoseMmol: 4.5,
    });
  });

  it("prefers the same instant over a nearer-looking neighbour", () => {
    const [point] = pairGlucoseKetoneIndex(
      [reading("k1", 0, 1)],
      [reading("g-early", -1, 200), reading("g-same", 0, 90)],
    );
    expect(point?.glucoseId).toBe("g-same");
  });

  it("takes the nearest glucose inside the window, before or after", () => {
    const [before] = pairGlucoseKetoneIndex(
      [reading("k1", 0, 1)],
      [reading("g-far", -14, 100), reading("g-near", -3, 90)],
    );
    expect(before?.glucoseId).toBe("g-near");
    const [after] = pairGlucoseKetoneIndex(
      [reading("k1", 0, 1)],
      [reading("g-after", 4, 90), reading("g-before", -9, 100)],
    );
    expect(after?.glucoseId).toBe("g-after");
  });

  it("pairs at the window's edge and never beyond it", () => {
    const edge = GKI_PAIRING_WINDOW_MINUTES;
    expect(
      pairGlucoseKetoneIndex([reading("k1", 0, 1)], [reading("g1", edge, 90)]),
    ).toHaveLength(1);
    expect(
      pairGlucoseKetoneIndex([reading("k1", 0, 1)], [reading("g1", -edge, 90)]),
    ).toHaveLength(1);
    expect(
      pairGlucoseKetoneIndex(
        [reading("k1", 0, 1)],
        [reading("g1", edge + 0.5, 90), reading("g2", -(edge + 1), 90)],
      ),
    ).toEqual([]);
  });

  it("leaves out a ketone reading of zero or without a partner", () => {
    expect(
      pairGlucoseKetoneIndex(
        [reading("k-zero", 0, 0), reading("k-alone", 120, 1.4)],
        [reading("g1", 0, 90)],
      ),
    ).toEqual([]);
  });

  it("breaks a tie by source, then by the earlier reading", () => {
    const [bySource] = pairGlucoseKetoneIndex(
      [reading("k1", 0, 1, "MANUAL")],
      [reading("g-cgm", 0, 140, "APPLE_HEALTH"), reading("g-own", 0, 90)],
    );
    expect(bySource?.glucoseId).toBe("g-own");
    const [byTime] = pairGlucoseKetoneIndex(
      [reading("k1", 0, 1)],
      [reading("g-later", 5, 100), reading("g-earlier", -5, 90)],
    );
    expect(byTime?.glucoseId).toBe("g-earlier");
  });

  it("answers in ketone order whatever order the readings came in", () => {
    const points = pairGlucoseKetoneIndex(
      [reading("k2", 60, 2), reading("k1", 0, 1)],
      [reading("g2", 61, 90), reading("g1", 1, 90)],
    );
    expect(points.map((p) => [p.ketoneId, p.glucoseId])).toEqual([
      ["k1", "g1"],
      ["k2", "g2"],
    ]);
  });

  it("lets one glucose reading serve two ketone readings and names it", () => {
    const points = pairGlucoseKetoneIndex(
      [reading("k1", 0, 1), reading("k2", 6, 2)],
      [reading("g1", 3, 90)],
    );
    expect(points.map((p) => p.glucoseId)).toEqual(["g1", "g1"]);
    expect(points[1]!.value).toBeLessThan(points[0]!.value);
  });
});

describe("summariseGlucoseKetoneIndex", () => {
  it("summarises the indices and is null for none", () => {
    expect(summariseGlucoseKetoneIndex([])).toBeNull();
    const points = pairGlucoseKetoneIndex(
      [reading("k1", 0, 1), reading("k2", 60, 2), reading("k3", 120, 4)],
      [reading("g1", 0, 90), reading("g2", 60, 90), reading("g3", 120, 90)],
    );
    // 90 mg/dL = 4.995 mmol/L: indices 5.0, 2.5, 1.2.
    expect(points.map((p) => p.value)).toEqual([5, 2.5, 1.2]);
    expect(summariseGlucoseKetoneIndex(points)).toEqual({
      count: 3,
      mean: 2.9,
      min: 1.2,
      max: 5,
      latest: 1.2,
    });
  });
});
