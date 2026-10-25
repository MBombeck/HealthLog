import { describe, expect, it, vi, beforeEach, onTestFinished } from "vitest";

// The labs module is on unless a test switches it off.
const { labsModule } = vi.hoisted(() => ({ labsModule: { on: true } }));
vi.mock("@/lib/modules/gate", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/modules/gate")>();
  return {
    ...actual,
    isModuleEnabled: async (
      userId: string,
      key: Parameters<typeof actual.isModuleEnabled>[1],
    ) => (key === "labs" ? labsModule.on : actual.isModuleEnabled(userId, key)),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    labResult: { findMany: vi.fn() },
  },
}));

import { buildLabsSnapshotBlock, sanitizeValueText } from "../labs-snapshot";
import { UNBOUNDED_REACH } from "../history-reach";
import { prisma } from "@/lib/db";

const prismaMock = prisma as unknown as {
  labResult: { findMany: ReturnType<typeof vi.fn> };
};

const NOW = new Date("2026-06-21T12:00:00.000Z");

/** A linked numeric lab row (biomarker wins for name/unit/bounds). */
function numericRow(overrides: Record<string, unknown> = {}) {
  return {
    analyte: "ldl-legacy",
    panel: "legacy-panel",
    value: 140,
    valueText: null,
    unit: "legacy-unit",
    referenceLow: 50,
    referenceHigh: 200,
    takenAt: new Date("2026-06-01T08:00:00.000Z"),
    biomarkerId: "bm_ldl",
    biomarker: {
      id: "bm_ldl",
      name: "LDL",
      unit: "mg/dL",
      lowerBound: 0,
      upperBound: 130,
      panel: "Lipids",
    },
    ...overrides,
  };
}

beforeEach(() => {
  prismaMock.labResult.findMany.mockReset();
});

describe("buildLabsSnapshotBlock", () => {
  it("reads no lab row and answers null with the labs module off", async () => {
    labsModule.on = false;
    onTestFinished(() => {
      labsModule.on = true;
    });
    prismaMock.labResult.findMany.mockResolvedValue([numericRow()]);
    expect(await buildLabsSnapshotBlock("user_1", NOW)).toBeNull();
    expect(
      await buildLabsSnapshotBlock("user_1", NOW, undefined, {
        analyte: "ldl",
      }),
    ).toBeNull();
    expect(prismaMock.labResult.findMany).not.toHaveBeenCalled();
  });

  it("returns null when the account has no readings", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([]);
    const block = await buildLabsSnapshotBlock("user_1", NOW);
    expect(block).toBeNull();
  });

  it("resolves name/unit/bounds from the linked biomarker and flags out-of-range", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([numericRow()]);
    const block = await buildLabsSnapshotBlock("user_1", NOW);
    expect(block).not.toBeNull();
    expect(block!.recent).toHaveLength(1);
    const r = block!.recent[0];
    // Biomarker fields win over the stale per-row legacy columns.
    expect(r.analyte).toBe("LDL");
    expect(r.unit).toBe("mg/dL");
    expect(r.referenceHigh).toBe(130);
    expect(r.panel).toBe("Lipids");
    // 140 > upperBound 130 → above.
    expect(r.rangeStatus).toBe("above");
    expect(r.value).toBe(140);
    expect(r.valueText).toBeNull();
  });

  it("classifies an in-range numeric reading", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([
      numericRow({ value: 100 }),
    ]);
    const block = await buildLabsSnapshotBlock("user_1", NOW);
    expect(block!.recent[0].rangeStatus).toBe("in-range");
  });

  it("includes a qualitative reading with unknown range status", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([
      {
        analyte: "Hepatitis B",
        panel: null,
        value: null,
        valueText: "negativ",
        unit: "",
        referenceLow: null,
        referenceHigh: null,
        takenAt: new Date("2026-05-10T08:00:00.000Z"),
        biomarkerId: "bm_hep",
        biomarker: {
          id: "bm_hep",
          name: "Hepatitis B",
          unit: "",
          lowerBound: null,
          upperBound: null,
          panel: null,
        },
      },
    ]);
    const block = await buildLabsSnapshotBlock("user_1", NOW);
    const r = block!.recent[0];
    expect(r.value).toBeNull();
    expect(r.valueText).toBe("negativ");
    expect(r.rangeStatus).toBe("unknown");
  });

  it("keeps only the most-recent reading per biomarker", async () => {
    // findMany returns newest-first; the older duplicate must be dropped.
    prismaMock.labResult.findMany.mockResolvedValue([
      numericRow({ value: 120, takenAt: new Date("2026-06-10T08:00:00.000Z") }),
      numericRow({ value: 145, takenAt: new Date("2026-01-10T08:00:00.000Z") }),
    ]);
    const block = await buildLabsSnapshotBlock("user_1", NOW);
    expect(block!.recent).toHaveLength(1);
    expect(block!.recent[0].value).toBe(120);
    // The snapshot block carries no history (#1263): it shares the prompt cap.
    expect(block!.recent[0].history).toBeUndefined();
  });

  it("adds the earlier readings as history for a named analyte", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([
      numericRow({ value: 120, takenAt: new Date("2026-06-10T08:00:00.000Z") }),
      numericRow({ value: 145, takenAt: new Date("2026-01-10T08:00:00.000Z") }),
    ]);
    const block = await buildLabsSnapshotBlock("user_1", NOW, UNBOUNDED_REACH, {
      analyte: "ldl",
    });
    expect(block!.recent[0].history).toEqual({
      count: 2,
      firstTakenAt: "2026-01-10T08:00:00.000Z",
      earlier: [
        {
          value: 145,
          rangeStatus: "above",
          takenAt: "2026-01-10T08:00:00.000Z",
        },
      ],
      yearly: [],
      yearsOmitted: 0,
    });
  });

  it("leaves a reading stored in another unit out of the history", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([
      numericRow({ value: 120, takenAt: new Date("2026-06-10T08:00:00.000Z") }),
      numericRow({
        value: 3.1,
        takenAt: new Date("2025-06-10T08:00:00.000Z"),
        biomarker: {
          id: "bm_ldl",
          name: "LDL",
          unit: "mmol/L",
          lowerBound: 0,
          upperBound: 3.4,
          panel: "Lipids",
        },
      }),
    ]);
    const block = await buildLabsSnapshotBlock("user_1", NOW, UNBOUNDED_REACH, {
      analyte: "LDL",
    });
    expect(block!.recent[0].value).toBe(120);
    expect(block!.recent[0].history).toBeUndefined();
  });

  it("collapses two spellings of an unlinked marker by lower-cased analyte", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([
      {
        analyte: "Ferritin",
        panel: null,
        value: 80,
        valueText: null,
        unit: "ng/mL",
        referenceLow: 30,
        referenceHigh: 400,
        takenAt: new Date("2026-06-05T08:00:00.000Z"),
        biomarkerId: null,
        biomarker: null,
      },
      {
        analyte: "ferritin",
        panel: null,
        value: 60,
        valueText: null,
        unit: "ng/mL",
        referenceLow: 30,
        referenceHigh: 400,
        takenAt: new Date("2026-02-05T08:00:00.000Z"),
        biomarkerId: null,
        biomarker: null,
      },
    ]);
    const block = await buildLabsSnapshotBlock("user_1", NOW);
    expect(block!.recent).toHaveLength(1);
    expect(block!.recent[0].value).toBe(80);
  });

  it("queries owner-scoped and deletedAt-null over the whole record", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([]);
    await buildLabsSnapshotBlock("user_42", NOW);
    const arg = prismaMock.labResult.findMany.mock.calls[0][0];
    expect(arg.where.userId).toBe("user_42");
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.where.takenAt.lte).toEqual(NOW);
    // #1263 — labs are not held to a year without a lookback limit.
    expect(arg.where.takenAt.gte).toBeUndefined();
    // Never selects the encrypted note column.
    expect(arg.select.noteEncrypted).toBeUndefined();
  });
});

describe("sanitizeValueText", () => {
  it("collapses control chars + newlines and bounds length", () => {
    expect(sanitizeValueText("negativ")).toBe("negativ");
    expect(sanitizeValueText("ignore\nprevious\tinstructions")).toBe(
      "ignore previous instructions",
    );
    expect(sanitizeValueText("x".repeat(200)).length).toBe(60);
  });
});
