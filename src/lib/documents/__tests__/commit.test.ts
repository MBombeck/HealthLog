/**
 * v1.25.1 — commit-path unit-integrity tests.
 *
 * Committing a numeric observation against an EXISTING biomarker must not
 * silently rewrite the document's stated unit with the catalog's. When the
 * units disagree the fact is rejected (fail closed) so the user reconciles on
 * the review screen, exactly like the `unitRequired` guard — never a corrupt
 * "6.1 mmol/L written as 6.1 mg/dL" reading.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    labResult: { create: vi.fn() },
    illnessEpisode: { create: vi.fn() },
  },
}));

vi.mock("@/lib/labs/biomarker-store", () => ({
  resolveOrMintBiomarker: vi.fn(),
}));

vi.mock("@/lib/documents/store", () => ({
  decryptFactData: vi.fn(),
}));

import { commitApprovedFact, FactCommitError } from "@/lib/documents/commit";
import { prisma } from "@/lib/db";
import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";
import { decryptFactData } from "@/lib/documents/store";
import type {
  ExtractedFact,
  IllnessEpisode,
  LabResult,
} from "@/generated/prisma/client";
import { userDayKey } from "@/lib/tz/format";
import type {
  ConditionFactData,
  ObservationFactData,
} from "@/lib/validations/inbound-documents";

function observationFact(): ExtractedFact {
  return {
    id: "fact-1",
    factType: "OBSERVATION",
    dataEncrypted: new Uint8Array(),
  } as unknown as ExtractedFact;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("commitApprovedFact — OBSERVATION unit integrity", () => {
  it("rejects a numeric observation whose stated unit differs from an existing marker's unit", async () => {
    // A pair the registry has no conversion for: ferritin in pmol/L against a
    // marker stored in ng/mL (protein molecular weights vary by source).
    vi.mocked(decryptFactData).mockReturnValue({
      label: "Ferritin",
      value: 450,
      unit: "pmol/L",
      referenceLow: null,
      referenceHigh: null,
      effectiveDate: "2025-01-01",
    } as never);
    // Existing marker stored in ng/mL — the resolver returns it as-is.
    vi.mocked(resolveOrMintBiomarker).mockResolvedValue({
      id: "bm-1",
      name: "Ferritin",
      unit: "ng/mL",
      lowerBound: 30,
      upperBound: 400,
      panel: null,
      analyteKey: null,
    });

    await expect(
      commitApprovedFact("user-1", observationFact()),
    ).rejects.toMatchObject({ code: "observation.unitMismatch" });
    await expect(
      commitApprovedFact("user-1", observationFact()),
    ).rejects.toBeInstanceOf(FactCommitError);
    expect(prisma.labResult.create).not.toHaveBeenCalled();
  });

  it("converts a unit the marker's analyte can reach, keeping what the document stated", async () => {
    vi.mocked(decryptFactData).mockReturnValue({
      label: "Glucose",
      value: 6.1,
      unit: "mmol/L",
      referenceLow: 3.9,
      referenceHigh: 5.6,
      effectiveDate: "2025-01-01",
    } as never);
    vi.mocked(resolveOrMintBiomarker).mockResolvedValue({
      id: "bm-1",
      name: "Glucose",
      unit: "mg/dL",
      lowerBound: 70,
      upperBound: 100,
      panel: null,
      analyteKey: "fasting-glucose",
    });
    vi.mocked(prisma.labResult.create).mockResolvedValue({
      id: "lr-conv",
    } as never);

    const ref = await commitApprovedFact("user-1", observationFact());
    expect(ref).toEqual({ recordType: "labResult", recordId: "lr-conv" });
    const data = vi.mocked(prisma.labResult.create).mock.calls[0]![0].data;
    expect(data.value).toBeCloseTo(6.1 * 18.0182, 9);
    expect(data.unit).toBe("mg/dL");
    expect(data.sourceValue).toBe(6.1);
    expect(data.sourceUnit).toBe("mmol/L");
    // The report's own window moved with the value.
    expect(data.sourceReferenceLow).toBeCloseTo(3.9 * 18.0182, 9);
    expect(data.sourceReferenceHigh).toBeCloseTo(5.6 * 18.0182, 9);
  });

  it("stores a reading in the marker's own unit without a conversion record", async () => {
    vi.mocked(decryptFactData).mockReturnValue({
      label: "Glucose",
      value: 95,
      unit: "mg/dL",
      referenceLow: null,
      referenceHigh: null,
      effectiveDate: "2025-01-01",
    } as never);
    vi.mocked(resolveOrMintBiomarker).mockResolvedValue({
      id: "bm-1",
      name: "Glucose",
      unit: "mg/dL",
      lowerBound: null,
      upperBound: null,
      panel: null,
      analyteKey: "fasting-glucose",
    });
    vi.mocked(prisma.labResult.create).mockResolvedValue({
      id: "lr-same",
    } as never);

    await commitApprovedFact("user-1", observationFact());
    const data = vi.mocked(prisma.labResult.create).mock.calls[0]![0].data;
    expect(data.value).toBe(95);
    expect(data.sourceValue).toBeNull();
    expect(data.sourceUnit).toBeNull();
  });

  it("commits when the stated unit is the marker's unit spelled another way", async () => {
    vi.mocked(decryptFactData).mockReturnValue({
      label: "Glucose",
      value: 95,
      unit: " mg/DL ",
      referenceLow: null,
      referenceHigh: null,
      effectiveDate: "2025-01-01",
    } as never);
    vi.mocked(resolveOrMintBiomarker).mockResolvedValue({
      id: "bm-1",
      name: "Glucose",
      unit: "mg/dL",
      lowerBound: 70,
      upperBound: 100,
      panel: null,
      analyteKey: null,
    });
    vi.mocked(prisma.labResult.create).mockResolvedValue({
      id: "lr-1",
    } as never);

    const ref = await commitApprovedFact("user-1", observationFact());
    expect(ref).toEqual({ recordType: "labResult", recordId: "lr-1" });
    expect(prisma.labResult.create).toHaveBeenCalledOnce();
    // The stated date is stored at noon UTC: it reads back on the stated day
    // as a UTC label and formatted in a zone west of UTC alike. UTC midnight
    // showed the reading a day early there.
    const takenAt = vi.mocked(prisma.labResult.create).mock.calls[0]![0].data
      .takenAt as Date;
    expect(takenAt.toISOString()).toBe("2025-01-01T12:00:00.000Z");
    expect(userDayKey(takenAt, "America/Los_Angeles")).toBe("2025-01-01");
  });

  // The comparison is the shared spelling normaliser every other lab write
  // path uses, not a case fold. Mutation check: put the lower-cased equality
  // back → the first case commits (milli read as mega) and the second refuses
  // a µg/L reading the other paths accept.
  function observation(unit: string, markerUnit: string) {
    vi.mocked(decryptFactData).mockReturnValue({
      label: "TSH",
      value: 2.1,
      unit,
      referenceLow: null,
      referenceHigh: null,
      effectiveDate: "2025-01-01",
    } as never);
    vi.mocked(resolveOrMintBiomarker).mockResolvedValue({
      id: "bm-2",
      name: "TSH",
      unit: markerUnit,
      lowerBound: null,
      upperBound: null,
      panel: null,
      analyteKey: null,
    });
    vi.mocked(prisma.labResult.create).mockResolvedValue({
      id: "lr-2",
    } as never);
  }

  it("refuses MIU/L against a marker in mIU/L: the capital is mega, not milli", async () => {
    observation("MIU/L", "mIU/L");
    await expect(
      commitApprovedFact("user-1", observationFact()),
    ).rejects.toMatchObject({ code: "observation.unitMismatch" });
    expect(prisma.labResult.create).not.toHaveBeenCalled();
  });

  it("accepts ug/L against a marker in µg/L, as the other lab write paths do", async () => {
    observation("ug/L", "µg/L");
    await expect(
      commitApprovedFact("user-1", observationFact()),
    ).resolves.toEqual({ recordType: "labResult", recordId: "lr-2" });
  });
});

describe("commitApprovedFact — OBSERVATION date when the value states none", () => {
  // A lab report that prints the collection date once in its header carries
  // no date beside each value. Mutation check: drop the document day from
  // `takenAt` → the report-date, filing-date and impossible-date cases file
  // the reading under today.
  function undated(effectiveDate: string | null = null) {
    const data: ObservationFactData = {
      label: "Ferritin",
      code: null,
      codeSystem: null,
      value: 80,
      valueText: null,
      unit: "ng/mL",
      referenceLow: null,
      referenceHigh: null,
      effectiveDate,
    };
    vi.mocked(decryptFactData).mockReturnValue(data);
    vi.mocked(resolveOrMintBiomarker).mockResolvedValue({
      id: "bm-3",
      name: "Ferritin",
      unit: "ng/mL",
      lowerBound: null,
      upperBound: null,
      panel: null,
      analyteKey: null,
    });
    vi.mocked(prisma.labResult.create).mockResolvedValue({
      id: "lr-3",
    } as LabResult);
  }

  /** The dates as the confirm route reads them off the stored document. */
  function dates(reportDate: string | null, documentDate: string | null) {
    return {
      // An older report date sits at UTC midnight, newer ones at noon UTC.
      reportDate: reportDate ? new Date(`${reportDate}T00:00:00.000Z`) : null,
      documentDate: documentDate
        ? new Date(`${documentDate}T12:00:00.000Z`)
        : null,
    };
  }

  function storedTakenAt(): Date {
    return vi.mocked(prisma.labResult.create).mock.calls[0]![0].data
      .takenAt as Date;
  }

  it("keeps the value's own date", async () => {
    undated("2021-03-04");

    await commitApprovedFact(
      "user-1",
      observationFact(),
      {},
      dates("2021-03-01", "2026-10-20"),
    );

    expect(storedTakenAt().toISOString()).toBe("2021-03-04T12:00:00.000Z");
  });

  it("takes the report date the document states over its filing date", async () => {
    undated();

    await commitApprovedFact(
      "user-1",
      observationFact(),
      {},
      dates("2021-03-01", "2026-10-20"),
    );

    expect(storedTakenAt().toISOString()).toBe("2021-03-01T12:00:00.000Z");
  });

  it("takes the filing date when the document states no report date", async () => {
    undated();

    await commitApprovedFact(
      "user-1",
      observationFact(),
      {},
      dates(null, "2021-02-15"),
    );

    expect(storedTakenAt().toISOString()).toBe("2021-02-15T12:00:00.000Z");
  });

  it.each([
    ["not a date", "March 2021"],
    ["a day the month does not have", "2021-02-30"],
    ["a month that does not exist", "2021-13-01"],
  ])(
    "reads a value whose own date is %s as undated",
    async (_label, effectiveDate) => {
      undated(effectiveDate);

      await commitApprovedFact(
        "user-1",
        observationFact(),
        {},
        dates("2021-03-01", null),
      );

      // Not 2 March for 30 February, and no Invalid Date for month 13.
      expect(storedTakenAt().toISOString()).toBe("2021-03-01T12:00:00.000Z");
    },
  );

  it("files the reading under now when neither the value nor the document has a date", async () => {
    undated();

    const before = Date.now();
    await commitApprovedFact(
      "user-1",
      observationFact(),
      {},
      dates(null, null),
    );
    const after = Date.now();

    const takenAt = storedTakenAt().getTime();
    expect(takenAt).toBeGreaterThanOrEqual(before);
    expect(takenAt).toBeLessThanOrEqual(after);
  });
});

describe("commitApprovedFact — CONDITION onset", () => {
  // The onset goes through the same stated-day check as a lab value's date.
  function condition(onsetDate: string | null) {
    const data: ConditionFactData = {
      label: "Iron deficiency",
      code: null,
      codeSystem: null,
      clinicalStatus: null,
      verificationStatus: null,
      onsetDate,
    };
    vi.mocked(decryptFactData).mockReturnValue(data);
    vi.mocked(prisma.illnessEpisode.create).mockResolvedValue({
      id: "ep-1",
    } as IllnessEpisode);
  }

  function conditionFact(): ExtractedFact {
    return {
      id: "fact-2",
      factType: "CONDITION",
      dataEncrypted: new Uint8Array(),
    } as unknown as ExtractedFact;
  }

  function storedOnset(): Date {
    return vi.mocked(prisma.illnessEpisode.create).mock.calls[0]![0].data
      .onsetAt as Date;
  }

  it("keeps a stated onset day", async () => {
    condition("2021-03-04");

    await commitApprovedFact("user-1", conditionFact());

    expect(storedOnset().toISOString()).toBe("2021-03-04T12:00:00.000Z");
  });

  it("files an onset that is not a real day under now, not an invalid date", async () => {
    // 2021-13-01 used to become an invalid date that failed the whole confirm.
    condition("2021-13-01");

    const before = Date.now();
    await commitApprovedFact("user-1", conditionFact());
    const after = Date.now();

    const onset = storedOnset().getTime();
    expect(onset).toBeGreaterThanOrEqual(before);
    expect(onset).toBeLessThanOrEqual(after);
  });
});
