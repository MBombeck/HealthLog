/**
 * A value without a unit, on the document-review commit path.
 *
 * A ratio or an index is saved only when somebody chose "no unit" on the
 * review screen, which stores the UCUM unity `"1"`. A numeric value whose unit
 * is simply missing is still refused: for most analytes that means the
 * extraction dropped the unit, and saving it would hide that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    labResult: { create: vi.fn() },
    biomarker: { updateMany: vi.fn(), findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/labs/biomarker-store", () => ({
  resolveOrMintBiomarker: vi.fn(),
}));

vi.mock("@/lib/documents/store", () => ({
  decryptFactData: vi.fn(),
}));

import type { ExtractedFact, LabResult } from "@/generated/prisma/client";
import { commitApprovedFact } from "@/lib/documents/commit";
import { decryptFactData } from "@/lib/documents/store";
import { prisma } from "@/lib/db";
import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";
import type { ObservationFactData } from "@/lib/validations/inbound-documents";

const FACT = {
  id: "fact-1",
  factType: "OBSERVATION",
  dataEncrypted: new Uint8Array(),
} as unknown as ExtractedFact;

function stated(unit: string | null): void {
  const data: ObservationFactData = {
    label: "Cholesterol/HDL ratio",
    code: null,
    codeSystem: null,
    value: 3.6,
    valueText: null,
    unit,
    referenceLow: null,
    referenceHigh: null,
    referenceText: "< 5.0",
    effectiveDate: "2026-08-01",
  };
  vi.mocked(decryptFactData).mockReturnValue(data);
}

function marker(unit: string): void {
  vi.mocked(resolveOrMintBiomarker).mockResolvedValue({
    id: "bm-ratio",
    name: "Cholesterol/HDL ratio",
    unit,
    lowerBound: null,
    upperBound: 5,
    panel: null,
    analyteKey: null,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.labResult.create).mockResolvedValue({
    id: "lr-1",
    takenAt: new Date("2026-08-01T12:00:00Z"),
    panel: null,
  } as unknown as LabResult);
});

describe("commitApprovedFact — a value without a unit", () => {
  it("saves a value the reviewer marked as having no unit", async () => {
    stated("1");
    marker("1");
    const ref = await commitApprovedFact("user-1", FACT);
    expect(ref).toEqual({ recordType: "labResult", recordId: "lr-1" });
    const data = vi.mocked(prisma.labResult.create).mock.calls[0]![0].data;
    expect(data.unit).toBe("1");
    expect(data.value).toBe(3.6);
    expect(data.sourceUnit).toBeNull();
    // The minted marker carries the unity, so later readings match it.
    expect(vi.mocked(resolveOrMintBiomarker).mock.calls[0]![1].unit).toBe("1");
  });

  it.each([null, "", "   "])(
    "still refuses a numeric value whose unit is missing (%j)",
    async (unit) => {
      stated(unit);
      marker("1");
      await expect(commitApprovedFact("user-1", FACT)).rejects.toMatchObject({
        code: "observation.unitRequired",
      });
      expect(prisma.labResult.create).not.toHaveBeenCalled();
    },
  );

  it("refuses no unit against a marker kept in a real unit", async () => {
    stated("1");
    marker("mg/dL");
    await expect(commitApprovedFact("user-1", FACT)).rejects.toMatchObject({
      code: "observation.unitMismatch",
    });
    expect(prisma.labResult.create).not.toHaveBeenCalled();
  });

  it("refuses a real unit against a marker without one", async () => {
    stated("mg/dL");
    marker("1");
    await expect(commitApprovedFact("user-1", FACT)).rejects.toMatchObject({
      code: "observation.unitMismatch",
    });
  });
});
