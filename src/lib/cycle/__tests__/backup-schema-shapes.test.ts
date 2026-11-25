/**
 * The cycle slices of the backup schema against the shared slice contract
 * (`src/lib/export/__tests__/slice-contract.ts`), plus the rules only these
 * slices carry: the sensitive fields as an object or a sealed string, and the
 * pregnancy state with its calendar-day keys and week bounds.
 */
import { describe, expect, it } from "vitest";

import {
  AT,
  describeSlice,
  issuePaths,
} from "@/lib/export/__tests__/slice-contract";
import {
  cycleDayLogSchema,
  cycleProfileSchema,
  cycleSpanSchema,
  cycleSymptomSeveritySchema,
} from "../backup-schema";

describeSlice("a cycle", {
  schema: cycleSpanSchema,
  valid: {
    id: "cy-2",
    startDate: "2026-06-01",
    endDate: "2026-06-28",
    lengthDays: 28,
    absorbedIntoId: "cy-1",
  },
  required: ["startDate"],
  nonEmpty: ["id", "startDate", "absorbedIntoId"],
  wrongType: { lengthDays: 27.5 },
});

describeSlice("a symptom's severity on a cycle day", {
  schema: cycleSymptomSeveritySchema,
  valid: { key: "cramps", severity: 2 },
  required: ["key"],
  nonEmpty: ["key"],
});

describeSlice("a cycle day", {
  schema: cycleDayLogSchema,
  valid: {
    id: "cd-1",
    date: "2026-06-02",
    sensitive: { sexualActivity: true, protectedSex: true },
    symptomKeys: ["cramps"],
    symptomSeverities: [{ key: "cramps", severity: 2 }],
    symptomLinkCreatedAt: [{ key: "cramps", createdAt: AT }],
    symptomSources: [{ key: "cramps", source: "MANUAL" }],
  },
  required: ["date"],
  nonEmpty: ["id", "date"],
  defaults: { symptomKeys: [], symptomSeverities: [] },
  accepts: [
    ["sensitive", "c2VhbGVk"],
    ["sensitive", null],
  ],
  refuses: [
    ["sensitive", { sexualActivity: "yes" }],
    ["sensitive", 5],
    ["symptomSeverities", [{ key: "", severity: 2 }]],
    ["symptomLinkCreatedAt", [{ key: "cramps" }]],
    ["symptomLinkCreatedAt", [{ key: "", createdAt: AT }]],
    ["symptomSources", [{ source: "MANUAL" }]],
    ["symptomSources", [{ key: "", source: "MANUAL" }]],
  ],
});

describe("the sensitive fields of a cycle day", () => {
  it("restores only the fields the sensitive set is made of", () => {
    const parsed = cycleDayLogSchema.parse({
      date: "2026-06-02",
      sensitive: { sexualActivity: false, unexpected: "dropped" },
    });
    expect(parsed.sensitive).toEqual({ sexualActivity: false });
  });
});

describeSlice("the cycle profile", {
  schema: cycleProfileSchema,
  valid: {
    id: "cp-1",
    reproductiveState: "POSTPARTUM",
    pregnancyStartDate: "2025-09-01",
    pregnancyDueDate: "2026-06-08",
    deliveryDate: "2026-06-01",
    postpartumWeeks: 3,
    pregnancyOwnerDecided: true,
    pregnancyEncrypted: "c2VhbGVk",
  },
  nonEmpty: ["id", "pregnancyEncrypted"],
  accepts: [
    ["reproductiveState", "PREGNANT"],
    ["reproductiveState", null],
    ["postpartumWeeks", 1],
    ["postpartumWeeks", 78],
  ],
  refuses: [
    ["reproductiveState", "MENOPAUSE"],
    ["reproductiveState", ""],
    ["postpartumWeeks", 0],
    ["postpartumWeeks", 79],
    ["postpartumWeeks", 2.5],
  ],
});

describe("a pregnancy date in the cycle profile", () => {
  it.each(["pregnancyStartDate", "pregnancyDueDate", "deliveryDate"])(
    "is a calendar day for %s",
    (field) => {
      expect(issuePaths(cycleProfileSchema, { [field]: "2026-06-08" })).toEqual(
        [],
      );
      expect(issuePaths(cycleProfileSchema, { [field]: null })).toEqual([]);
    },
  );

  it.each([
    ["a short month", "2026-6-08"],
    ["a short day", "2026-06-8"],
    ["a short year", "226-06-08"],
    ["a long year", "20260-06-08"],
    ["a prefix", "x2026-06-08"],
    ["a suffix", "2026-06-08x"],
    ["a time", "2026-06-08T00:00:00Z"],
    ["letters for the year", "abcd-06-08"],
    ["letters for the month", "2026-ab-08"],
    ["letters for the day", "2026-06-ab"],
  ])("refuses %s", (_, value) => {
    expect(issuePaths(cycleProfileSchema, { pregnancyDueDate: value })).toEqual(
      ["pregnancyDueDate"],
    );
  });
});
