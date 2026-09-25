/**
 * v1.16.10 — inventory + units-per-dose validation bounds.
 *
 * Pins the raised unit caps (100 → 1000 on container capacity and the
 * stock correction; `dosesPerUnit` rides along), the new
 * `unitsPerDose` (1–100) and `containerType` fields, and the symmetric
 * request field names (`unitsTotal` / `unitsRemaining` — the response
 * always carried them). The GLP-1 legacy ledger delta deliberately
 * KEEPS its ±100 bound — it counts pens, not units.
 */
import { describe, expect, it } from "vitest";

import {
  createInventoryItemSchema,
  updateInventoryItemSchema,
  createMedicationSchema,
  updateMedicationSchema,
  glp1InventoryPostSchema,
} from "../medication";

const MINIMAL_MEDICATION = {
  name: "Med",
  dose: "5 mg",
  schedules: [
    {
      windowStart: "08:00",
      windowEnd: "09:00",
    },
  ],
};

describe("createInventoryItemSchema — unit cap 1000", () => {
  it("accepts 1000 units", () => {
    const r = createInventoryItemSchema.safeParse({ unitsTotal: 1000 });
    expect(r.success).toBe(true);
  });

  it("rejects 1001 units", () => {
    const r = createInventoryItemSchema.safeParse({ unitsTotal: 1001 });
    expect(r.success).toBe(false);
  });

  it("rejects zero", () => {
    const r = createInventoryItemSchema.safeParse({ unitsTotal: 0 });
    expect(r.success).toBe(false);
  });

  it("accepts every container type and defaults to absent", () => {
    for (const ct of [
      "PEN",
      "AMPOULE",
      "BLISTER",
      "INHALER",
      "BOTTLE",
      "OTHER",
    ]) {
      const r = createInventoryItemSchema.safeParse({
        unitsTotal: 4,
        containerType: ct,
      });
      expect(r.success).toBe(true);
    }
    const r = createInventoryItemSchema.safeParse({ unitsTotal: 4 });
    expect(r.success).toBe(true);
    expect(r.success && r.data.containerType).toBeUndefined();
  });

  it("rejects an unknown container type", () => {
    const r = createInventoryItemSchema.safeParse({
      unitsTotal: 4,
      containerType: "BAG",
    });
    expect(r.success).toBe(false);
  });
});

describe("updateInventoryItemSchema — stock correction cap 1000", () => {
  it("accepts 1000", () => {
    const r = updateInventoryItemSchema.safeParse({ unitsRemaining: 1000 });
    expect(r.success).toBe(true);
  });

  it("rejects 1001", () => {
    const r = updateInventoryItemSchema.safeParse({ unitsRemaining: 1001 });
    expect(r.success).toBe(false);
  });
});

describe("medication schemas — dosesPerUnit cap 1000 + unitsPerDose 1–100", () => {
  it("create accepts dosesPerUnit 1000 and rejects 1001", () => {
    expect(
      createMedicationSchema.safeParse({
        ...MINIMAL_MEDICATION,
        dosesPerUnit: 1000,
      }).success,
    ).toBe(true);
    expect(
      createMedicationSchema.safeParse({
        ...MINIMAL_MEDICATION,
        dosesPerUnit: 1001,
      }).success,
    ).toBe(false);
  });

  it("update accepts dosesPerUnit 1000 and rejects 1001", () => {
    expect(
      updateMedicationSchema.safeParse({ dosesPerUnit: 1000 }).success,
    ).toBe(true);
    expect(
      updateMedicationSchema.safeParse({ dosesPerUnit: 1001 }).success,
    ).toBe(false);
  });

  it("create bounds unitsPerDose to 1–100", () => {
    expect(
      createMedicationSchema.safeParse({
        ...MINIMAL_MEDICATION,
        unitsPerDose: 1,
      }).success,
    ).toBe(true);
    expect(
      createMedicationSchema.safeParse({
        ...MINIMAL_MEDICATION,
        unitsPerDose: 100,
      }).success,
    ).toBe(true);
    expect(
      createMedicationSchema.safeParse({
        ...MINIMAL_MEDICATION,
        unitsPerDose: 0,
      }).success,
    ).toBe(false);
    expect(
      createMedicationSchema.safeParse({
        ...MINIMAL_MEDICATION,
        unitsPerDose: 101,
      }).success,
    ).toBe(false);
    expect(
      createMedicationSchema.safeParse({
        ...MINIMAL_MEDICATION,
        unitsPerDose: 100.5,
      }).success,
    ).toBe(false);
  });

  it("update bounds unitsPerDose to 1–100", () => {
    expect(updateMedicationSchema.safeParse({ unitsPerDose: 2 }).success).toBe(
      true,
    );
    expect(updateMedicationSchema.safeParse({ unitsPerDose: 0 }).success).toBe(
      false,
    );
    expect(
      updateMedicationSchema.safeParse({ unitsPerDose: 101 }).success,
    ).toBe(false);
  });

  // v1.16.12 (#316) — fractional dosing: a curated set of split-pill
  // fractions is accepted alongside the whole numbers.
  it("accepts every curated unitsPerDose fraction on create + update", () => {
    for (const v of [0.25, 0.3333, 0.5, 0.6667, 0.75]) {
      expect(
        createMedicationSchema.safeParse({
          ...MINIMAL_MEDICATION,
          unitsPerDose: v,
        }).success,
      ).toBe(true);
      expect(
        updateMedicationSchema.safeParse({ unitsPerDose: v }).success,
      ).toBe(true);
    }
  });

  // #1034 — a whole number plus a fraction (1½, 2¼), and any other value
  // the Decimal(10,4) column stores exactly, is accepted on create + update.
  it("accepts a mixed or free decimal unitsPerDose with up to four places", () => {
    for (const v of [1.5, 2.25, 1.3333, 3.75, 0.1, 0.4, 1.2, 99.5]) {
      expect(
        createMedicationSchema.safeParse({
          ...MINIMAL_MEDICATION,
          unitsPerDose: v,
        }).success,
      ).toBe(true);
      expect(
        updateMedicationSchema.safeParse({ unitsPerDose: v }).success,
      ).toBe(true);
    }
  });

  it("rejects a unitsPerDose with more than four decimal places", () => {
    for (const v of [1.23456, 0.33333, 0.00001]) {
      expect(
        createMedicationSchema.safeParse({
          ...MINIMAL_MEDICATION,
          unitsPerDose: v,
        }).success,
      ).toBe(false);
      expect(
        updateMedicationSchema.safeParse({ unitsPerDose: v }).success,
      ).toBe(false);
    }
  });

  it("accepts a fractional remaining-stock correction (½-tablet leftover)", () => {
    expect(
      updateInventoryItemSchema.safeParse({ unitsRemaining: 29.5 }).success,
    ).toBe(true);
    expect(
      createInventoryItemSchema.safeParse({ unitsTotal: 1.5 }).success,
    ).toBe(true);
  });
});

describe("glp1InventoryPostSchema — the legacy pen-ledger delta keeps ±100", () => {
  it("accepts ±100 and rejects ±101", () => {
    expect(
      glp1InventoryPostSchema.safeParse({ delta: 100, reason: "purchased" })
        .success,
    ).toBe(true);
    expect(
      glp1InventoryPostSchema.safeParse({ delta: -100, reason: "damaged" })
        .success,
    ).toBe(true);
    expect(
      glp1InventoryPostSchema.safeParse({ delta: 101, reason: "purchased" })
        .success,
    ).toBe(false);
    expect(
      glp1InventoryPostSchema.safeParse({ delta: -101, reason: "damaged" })
        .success,
    ).toBe(false);
  });
});
