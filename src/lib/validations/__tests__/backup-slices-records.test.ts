/**
 * The record-shaped backup slices, one rule at a time: the health score
 * day, the intraday curve, a medication with its composition and custom
 * category, an intake row, and the cycle's own symptoms.
 *
 * Like `backup-slices.test.ts`, each rule meets the value just inside and
 * just outside it. The defaults are pinned as well: a file written before a
 * field existed restores through them, so a default that drifted would
 * change what an older file means without any parse failing.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";

import { customCycleSymptomSchema } from "@/lib/cycle/backup-schema";
import { healthScoreRecordBackupSchema } from "@/lib/export/health-score-backup-schema";
import { intradayProfileBackupSchema } from "@/lib/export/intraday-profile-backup-schema";
import {
  customMedicationCategorySchema,
  intakeEventSchema,
  medicationIngredientSchema,
  medicationSchema,
  medicationSideEffectSchema,
} from "@/lib/export/medications-backup-schema";

/** The paths a value is refused on, or `[]` when it parses. */
function refused(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

const AT = "2026-07-01T08:00:00.000Z";
const BAD_DAY_KEYS = [
  "x2026-07-01",
  "2026-07-01x",
  "226-07-01",
  "2026-7-01",
  "2026-07-1",
  "abcd-07-01",
  "2026-ab-01",
  "2026-07-ab",
];

describe("the health score day", () => {
  const day = {
    id: "hs-1",
    dayKey: "2026-07-01",
    timezone: "Europe/Berlin",
    composite: 72,
    band: "green",
    scoreVersion: 3,
    composition: ["sleep", "activity"],
    pillarScores: { sleep: 80 },
    inputFingerprint: "a".repeat(64),
    computedAt: AT,
  };

  it("takes a well-formed day and defaults the config stamp to null", () => {
    expect(refused(healthScoreRecordBackupSchema, day)).toEqual([]);
    const out = parsed(healthScoreRecordBackupSchema, day) as {
      configVersion: unknown;
      configChangedAt: unknown;
    };
    expect(out.configVersion).toBeNull();
    expect(out.configChangedAt).toBeNull();
  });

  it("wants an anchored YYYY-MM-DD day key", () => {
    for (const dayKey of BAD_DAY_KEYS) {
      expect(
        refused(healthScoreRecordBackupSchema, { ...day, dayKey }),
        dayKey,
      ).toEqual(["dayKey"]);
    }
  });

  it("refuses an empty id and an empty zone", () => {
    expect(refused(healthScoreRecordBackupSchema, { ...day, id: "" })).toEqual([
      "id",
    ]);
    expect(
      refused(healthScoreRecordBackupSchema, { ...day, timezone: "" }),
    ).toEqual(["timezone"]);
  });

  it("holds the composite to 0 through 100", () => {
    for (const composite of [0, 100]) {
      expect(
        refused(healthScoreRecordBackupSchema, { ...day, composite }),
      ).toEqual([]);
    }
    for (const composite of [-1, 101]) {
      expect(
        refused(healthScoreRecordBackupSchema, { ...day, composite }),
      ).toEqual(["composite"]);
    }
  });

  it("takes every band the column allows and nothing else", () => {
    for (const band of ["green", "yellow", "red"]) {
      expect(refused(healthScoreRecordBackupSchema, { ...day, band })).toEqual(
        [],
      );
    }
    expect(
      refused(healthScoreRecordBackupSchema, { ...day, band: "" }),
    ).toEqual(["band"]);
  });

  it("wants at least one named pillar in the composition", () => {
    expect(
      refused(healthScoreRecordBackupSchema, { ...day, composition: ["a"] }),
    ).toEqual([]);
    expect(
      refused(healthScoreRecordBackupSchema, { ...day, composition: [] }),
    ).toEqual(["composition"]);
    expect(
      refused(healthScoreRecordBackupSchema, {
        ...day,
        composition: ["sleep", ""],
      }),
    ).toEqual(["composition.1"]);
  });

  it("wants a fingerprint of exactly 64 lowercase hex digits", () => {
    for (const inputFingerprint of [
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      `x${"a".repeat(64)}`,
      `${"a".repeat(64)}x`,
      "a",
    ]) {
      expect(
        refused(healthScoreRecordBackupSchema, { ...day, inputFingerprint }),
        inputFingerprint,
      ).toEqual(["inputFingerprint"]);
    }
  });
});

describe("the intraday curve", () => {
  const curve = {
    id: "ip-1",
    type: "ACTIVITY_STEPS",
    dateKey: "2026-07-01",
    hourlyCumulative: [0, 120],
    dayTotal: 120,
    sampleCount: 2,
    timezone: "UTC",
  };

  it("reads a file from before the hours travelled as a fold of samples", () => {
    const out = parsed(intradayProfileBackupSchema, curve) as {
      hourlyIncrements: unknown;
      basis: unknown;
      bucketCount: unknown;
    };
    expect(out.hourlyIncrements).toEqual([]);
    expect(out.basis).toBe("PER_SAMPLE");
    expect(out.bucketCount).toBeNull();
  });

  it("takes both bases and refuses another", () => {
    for (const basis of ["PER_SAMPLE", "HOUR_BUCKETS"]) {
      expect(refused(intradayProfileBackupSchema, { ...curve, basis })).toEqual(
        [],
      );
    }
    expect(
      refused(intradayProfileBackupSchema, { ...curve, basis: "" }),
    ).toEqual(["basis"]);
  });

  it("wants an anchored day key, a zone and a non-empty id", () => {
    for (const dateKey of BAD_DAY_KEYS) {
      expect(
        refused(intradayProfileBackupSchema, { ...curve, dateKey }),
        dateKey,
      ).toEqual(["dateKey"]);
    }
    expect(
      refused(intradayProfileBackupSchema, { ...curve, timezone: "" }),
    ).toEqual(["timezone"]);
    expect(refused(intradayProfileBackupSchema, { ...curve, id: "" })).toEqual([
      "id",
    ]);
  });
});

describe("a custom medication category", () => {
  const KEY = "custom:0f8fad5b-d9cb-469f-a165-70867728950e";

  it("takes a readable label and defaults its order and state", () => {
    const out = parsed(customMedicationCategorySchema, {
      key: KEY,
      label: "  Supplements ",
    }) as { label: unknown; sortOrder: unknown; isActive: unknown };
    expect(out.label).toBe("Supplements");
    expect(out.sortOrder).toBe(0);
    expect(out.isActive).toBe(true);
  });

  it("wants the custom: prefix and a 36-character id, anchored", () => {
    for (const key of [
      KEY.slice(0, -1),
      `${KEY}0`,
      `x${KEY}`,
      "custom:",
      "custom:zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
    ]) {
      expect(
        refused(customMedicationCategorySchema, { key, label: "A" }),
        key,
      ).toContain("key");
    }
  });

  it("holds the label to 1 through 40 characters after trimming", () => {
    expect(
      refused(customMedicationCategorySchema, {
        key: KEY,
        label: "x".repeat(40),
      }),
    ).toEqual([]);
    expect(
      refused(customMedicationCategorySchema, {
        key: KEY,
        label: "x".repeat(41),
      }),
    ).toEqual(["label"]);
    // Blank after trimming: the length rule and the label-or-ciphertext rule
    // both refuse it.
    expect(
      refused(customMedicationCategorySchema, { key: KEY, label: "   " }),
    ).toEqual(["label", "label"]);
  });

  it("refuses a negative order", () => {
    expect(
      refused(customMedicationCategorySchema, {
        key: KEY,
        label: "A",
        sortOrder: -1,
      }),
    ).toEqual(["sortOrder"]);
  });

  it("needs its label or its ciphertext, and names the label when both are missing", () => {
    expect(
      refused(customMedicationCategorySchema, {
        key: KEY,
        labelEncrypted: "QUJDRA==",
      }),
    ).toEqual([]);
    expect(
      refused(customMedicationCategorySchema, {
        key: KEY,
        label: null,
        labelEncrypted: "QUJDRA==",
      }),
    ).toEqual([]);
    const result = customMedicationCategorySchema.safeParse({ key: KEY });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["label"],
        message: "a custom category needs its label or its ciphertext",
      }),
    ]);
    expect(
      refused(customMedicationCategorySchema, { key: KEY, label: null }),
    ).toEqual(["label"]);
  });
});

describe("a medication", () => {
  it("restores a file from before its parts travelled with every part empty", () => {
    const out = parsed(medicationSchema, { name: "Ramipril", dose: "5 mg" });
    expect(out).toMatchObject({
      schedules: [],
      sideEffects: [],
      pauseEras: [],
      ingredients: [],
      doseChanges: [],
      inventoryItems: [],
      inventoryEvents: [],
      efficacyTargets: [],
      scheduleRevisions: [],
    });
    expect((out as { courses?: unknown }).courses).toBeUndefined();
  });

  it("refuses an empty name, id or ref and a category past 64 characters", () => {
    const base = { name: "Ramipril", dose: "5 mg" };
    expect(refused(medicationSchema, { ...base, name: "" })).toEqual(["name"]);
    expect(refused(medicationSchema, { ...base, id: "" })).toEqual(["id"]);
    expect(refused(medicationSchema, { ...base, ref: "" })).toEqual(["ref"]);
    expect(
      refused(medicationSchema, { ...base, category: "x".repeat(64) }),
    ).toEqual([]);
    expect(
      refused(medicationSchema, { ...base, category: "x".repeat(65) }),
    ).toEqual(["category"]);
  });

  it("names the side effect severity outside 1 through 5", () => {
    const effect = {
      occurredAt: AT,
      category: medicationSideEffectSchema.shape.category.options[0],
      entry: medicationSideEffectSchema.shape.entry.options[0],
    };
    for (const severity of [1, 5]) {
      expect(
        refused(medicationSideEffectSchema, { ...effect, severity }),
      ).toEqual([]);
    }
    for (const severity of [0, 6]) {
      expect(
        refused(medicationSideEffectSchema, { ...effect, severity }),
      ).toEqual(["severity"]);
    }
    expect(
      refused(medicationSideEffectSchema, { ...effect, severity: 3, id: "" }),
    ).toEqual(["id"]);
  });
});

describe("a composition ingredient", () => {
  const ingredient = {
    nutrient: "vitamin_d",
    amountPerUnit: 20,
    unit: "µg",
  };

  it("defaults its source to a hand entry and takes the label reader", () => {
    expect(
      (parsed(medicationIngredientSchema, ingredient) as { source: unknown })
        .source,
    ).toBe("MANUAL");
    expect(
      refused(medicationIngredientSchema, {
        ...ingredient,
        source: "LABEL_AI",
      }),
    ).toEqual([]);
    expect(
      refused(medicationIngredientSchema, { ...ingredient, source: "" }),
    ).toEqual(["source"]);
  });

  it("holds the nutrient to 1 through 40 and the units to 8 characters", () => {
    const at = (patch: Record<string, unknown>) =>
      refused(medicationIngredientSchema, { ...ingredient, ...patch });
    expect(at({ nutrient: "x".repeat(40) })).toEqual([]);
    expect(at({ nutrient: "x".repeat(41) })).toEqual(["nutrient"]);
    expect(at({ nutrient: "" })).toEqual(["nutrient"]);
    expect(at({ unit: "x".repeat(8) })).toEqual([]);
    expect(at({ unit: "x".repeat(9) })).toEqual(["unit"]);
    expect(at({ unit: "" })).toEqual(["unit"]);
    expect(at({ enteredUnit: "x".repeat(8) })).toEqual([]);
    expect(at({ enteredUnit: "x".repeat(9) })).toEqual(["enteredUnit"]);
    expect(at({ id: "" })).toEqual(["id"]);
  });
});

describe("an intake row", () => {
  it("names its medication, and refuses an empty one or empty ids", () => {
    const row = { medication: "Ramipril", scheduledFor: AT };
    expect(refused(intakeEventSchema, row)).toEqual([]);
    expect(refused(intakeEventSchema, { ...row, medication: "" })).toEqual([
      "medication",
    ]);
    expect(refused(intakeEventSchema, { ...row, id: "" })).toEqual(["id"]);
    expect(refused(intakeEventSchema, { ...row, medicationId: "" })).toEqual([
      "medicationId",
    ]);
  });
});

describe("a custom cycle symptom", () => {
  const symptom = {
    key: "custom-cramps",
    labelKey: "cycle.symptom.custom",
    categoryId: "cat-1",
  };

  it("defaults to active at the top of its list", () => {
    const out = parsed(customCycleSymptomSchema, symptom) as {
      isActive: unknown;
      sortOrder: unknown;
    };
    expect(out.isActive).toBe(true);
    expect(out.sortOrder).toBe(0);
  });

  it("refuses an empty key, label key, category or id", () => {
    for (const field of ["key", "labelKey", "categoryId", "id"]) {
      expect(
        refused(customCycleSymptomSchema, { ...symptom, [field]: "" }),
        field,
      ).toEqual([field]);
    }
  });
});
