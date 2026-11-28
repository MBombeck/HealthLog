import { describe, expect, it } from "vitest";

import {
  localiseEfficacyLabels,
  type EfficacyBeforeAfter,
  type MedicationEfficacyDTO,
} from "@/lib/medications/efficacy/build-efficacy";
import {
  efficacyDirection,
  efficacyResultOf,
} from "@/lib/medications/efficacy/efficacy-result";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { locales } from "@/lib/i18n/config";

/**
 * The effect view leads with one sentence, worded on the server so the web
 * page and the app say the same thing. It describes the before/after means
 * and nothing else: a direction and an amount, or which side is short of
 * readings.
 */
const present = (mean: number, pct: number | null): EfficacyBeforeAfter => ({
  present: true,
  before: { mean: 138, count: 20, from: "a", to: "b" },
  after: { mean: 138 + mean, count: 20, from: "c", to: "d" },
  delta: { mean, pct },
});

describe("efficacy result", () => {
  it("reads the direction off the delta, with a band for unchanged", () => {
    expect(efficacyDirection(present(-9, -6.5))).toBe("lower");
    expect(efficacyDirection(present(4, 2.9))).toBe("higher");
    expect(efficacyDirection(present(-1, -0.7))).toBe("unchanged");
    expect(efficacyDirection(present(0, null))).toBe("unchanged");
    expect(efficacyDirection({ present: false, reason: "no_data" })).toBe(null);
  });

  it("words the comparison with the amount and the unit", () => {
    const { t } = getServerTranslator("de");
    const result = efficacyResultOf(
      { beforeAfter: present(-9, -6.5), unit: "mmHg" },
      4,
      t,
      "de",
    );
    expect(result).toEqual({
      direction: "lower",
      text: "Seit dem Start liegt der Mittelwert 9\u00a0mmHg niedriger.",
    });
    const en = efficacyResultOf(
      { beforeAfter: present(1.5, 2.5), unit: "kg" },
      4,
      getServerTranslator("en").t,
      "en",
    );
    expect(en.text).toBe("Since the start, the average is 1.5\u00a0kg higher.");
  });

  it("says which side is short when there is no comparison", () => {
    const { t } = getServerTranslator("en");
    const before = efficacyResultOf(
      {
        beforeAfter: { present: false, reason: "insufficient_before" },
        unit: null,
      },
      4,
      t,
      "en",
    );
    expect(before.direction).toBeNull();
    expect(before.text).toContain("before the start");
    const start = efficacyResultOf(
      { beforeAfter: { present: false, reason: "no_start" }, unit: null },
      4,
      t,
      "en",
    );
    expect(start.text).toContain("start date");
  });

  it("has every sentence in every locale", () => {
    for (const locale of locales) {
      const { t } = getServerTranslator(locale);
      for (const key of [
        "lower",
        "higher",
        "unchanged",
        "needBefore",
        "needAfter",
        "needStart",
        "needData",
      ]) {
        const text = t(`serverText.efficacyResult.${key}`, {
          amount: "9\u00a0mmHg",
          weeks: 4,
        });
        expect(text, `${locale} ${key}`).not.toContain("serverText.");
        expect(text, `${locale} ${key}`).not.toContain("{");
      }
    }
  });

  it("puts the sentence on every target when the DTO is localised", () => {
    const dto = {
      minWeeksPerSide: 4,
      targets: [
        {
          kind: "metric",
          key: "BLOOD_PRESSURE_SYS",
          label: "serverText.metricLabels.systolicBloodPressure",
          unit: "mmHg",
          primary: true,
          referenceBand: null,
          series: [],
          beforeAfter: present(-9, -6.5),
          levelShift: null,
          segmented: null,
        },
      ],
      overrideOptions: { metrics: [], biomarkers: [] },
    } as unknown as MedicationEfficacyDTO;
    const { t } = getServerTranslator("de");
    const out = localiseEfficacyLabels(dto, t, "de");
    expect(out.targets[0].result?.direction).toBe("lower");
    expect(out.targets[0].label).not.toContain("serverText.");
  });
});
