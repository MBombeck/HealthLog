/**
 * The vaccination wire contract, at the boundary.
 *
 * Four properties are worth holding here rather than only at the route: the
 * either-arm rule (the one thing that IS mandatory beyond the date), the
 * future-date refusal (the split from the visit schema next door), the
 * catalogue check on write (the split from what storage accepts), and the
 * absence of `userId` (which is narrowed from auth in every route and must
 * never be something a body can name).
 */
import { describe, expect, it } from "vitest";

import {
  vaccinationCreateSchema,
  vaccinationLinkSchema,
  vaccinationListQuerySchema,
  vaccinationUpdateSchema,
} from "@/lib/validations/vaccinations";

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const NEXT_YEAR = new Date(
  Date.now() + 365 * 24 * 60 * 60 * 1000,
).toISOString();

function pathsOf(result: { success: false; error: { issues: unknown[] } }) {
  return (result.error.issues as Array<{ path: (string | number)[] }>).map(
    (issue) => issue.path.join("."),
  );
}

describe("a dose needs a date and one way of naming what it was", () => {
  it("accepts a catalogue pick with nothing else", () => {
    const parsed = vaccinationCreateSchema.safeParse({
      occurredAt: YESTERDAY,
      antigenSlug: "tdap",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts free text with nothing else, so a 1987 Pass line is loggable", () => {
    const parsed = vaccinationCreateSchema.safeParse({
      occurredAt: YESTERDAY,
      vaccineName: "Tetanol, as the Pass wrote it",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a body with neither, naming BOTH fields", () => {
    const parsed = vaccinationCreateSchema.safeParse({
      occurredAt: YESTERDAY,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // Both, so a client highlighting one field per issue highlights the pick
    // and the text box rather than leaving the person to guess which was
    // meant.
    expect(pathsOf(parsed).sort()).toEqual(["antigenSlug", "vaccineName"]);
  });

  it("returns every issue at once rather than the first", () => {
    const parsed = vaccinationCreateSchema.safeParse({
      occurredAt: "not-a-date",
      doseNumber: 99,
      lotNumber: "x".repeat(200),
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("a dose is logged after the fact", () => {
  it("refuses a date in the future", () => {
    const parsed = vaccinationCreateSchema.safeParse({
      occurredAt: NEXT_YEAR,
      antigenSlug: "tetanus",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(pathsOf(parsed)).toContain("occurredAt");
    expect(JSON.stringify(parsed.error.issues)).toMatch(
      /reminder, not a record/,
    );
  });

  it("allows a day's worth of clock skew, so a client east of here works", () => {
    const inSixHours = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    expect(
      vaccinationCreateSchema.safeParse({
        occurredAt: inSixHours,
        antigenSlug: "tetanus",
      }).success,
    ).toBe(true);
  });

  it("refuses a date before there were records to keep", () => {
    expect(
      vaccinationCreateSchema.safeParse({
        occurredAt: "1802-04-01T00:00:00.000Z",
        antigenSlug: "tetanus",
      }).success,
    ).toBe(false);
  });
});

describe("the write path is stricter than the column", () => {
  it("refuses a slug the catalogue does not offer", () => {
    const parsed = vaccinationCreateSchema.safeParse({
      occurredAt: YESTERDAY,
      antigenSlug: "not-a-real-antigen",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(pathsOf(parsed)).toContain("antigenSlug");
  });

  it("accepts every slug the catalogue does offer", () => {
    for (const slug of ["tetanus", "tdap", "hexavalent", "mmrv", "cholera"]) {
      expect(
        vaccinationCreateSchema.safeParse({
          occurredAt: YESTERDAY,
          antigenSlug: slug,
        }).success,
        slug,
      ).toBe(true);
    }
  });
});

describe("no body may name the account it writes to", () => {
  it("refuses a userId field on create", () => {
    const parsed = vaccinationCreateSchema.safeParse({
      occurredAt: YESTERDAY,
      antigenSlug: "tetanus",
      userId: "somebody-else",
    });
    expect(
      parsed.success,
      "userId is narrowed from auth; a body that can name it is a body that " +
        "can write into another account",
    ).toBe(false);
  });

  it("refuses a userId field on update", () => {
    expect(
      vaccinationUpdateSchema.safeParse({
        lotNumber: "AB-1",
        userId: "somebody-else",
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown field rather than ignoring it", () => {
    expect(
      vaccinationCreateSchema.safeParse({
        occurredAt: YESTERDAY,
        antigenSlug: "tetanus",
        manufacturer: "a trade name",
      }).success,
    ).toBe(false);
  });
});

describe("an edit names what it changes", () => {
  it("refuses a body that names nothing", () => {
    const parsed = vaccinationUpdateSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(parsed.error.issues)).toMatch(
      /name at least one field/,
    );
  });

  it("allows one field on its own", () => {
    expect(
      vaccinationUpdateSchema.safeParse({ lotNumber: "AB-1" }).success,
    ).toBe(true);
  });

  it("allows the date to be corrected", () => {
    expect(
      vaccinationUpdateSchema.safeParse({ occurredAt: YESTERDAY }).success,
    ).toBe(true);
  });

  it("refuses an edit that clears every identity arm at once", () => {
    expect(
      vaccinationUpdateSchema.safeParse({
        antigenSlug: null,
        vaccineName: null,
        customVaccineId: null,
      }).success,
    ).toBe(false);
  });

  it("leaves clearing the slug and the name to the merged-row check, because an own vaccine may remain", () => {
    expect(
      vaccinationUpdateSchema.safeParse({
        antigenSlug: null,
        vaccineName: null,
      }).success,
    ).toBe(true);
  });

  it("allows clearing one arm, because the other may still be there", () => {
    expect(
      vaccinationUpdateSchema.safeParse({ antigenSlug: null }).success,
    ).toBe(true);
  });
});

describe("the list query and the link body", () => {
  it("refuses a window that ends before it starts", () => {
    const parsed = vaccinationListQuerySchema.safeParse({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-06-01T00:00:00.000Z",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(pathsOf(parsed)).toContain("to");
  });

  it("coerces a limit from the query string and bounds it", () => {
    expect(vaccinationListQuerySchema.safeParse({ limit: "50" })).toMatchObject(
      {
        success: true,
        data: { limit: 50 },
      },
    );
    expect(
      vaccinationListQuerySchema.safeParse({ limit: "5000" }).success,
    ).toBe(false);
  });

  it("bounds a link call at the facade's own cap", () => {
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => `doc-${index}`);
    expect(
      vaccinationLinkSchema.safeParse({
        targetKind: "document",
        targetIds: ids(100),
      }).success,
    ).toBe(true);
    expect(
      vaccinationLinkSchema.safeParse({
        targetKind: "document",
        targetIds: ids(101),
      }).success,
    ).toBe(false);
  });

  it("knows exactly one link family", () => {
    expect(
      vaccinationLinkSchema.safeParse({
        targetKind: "labResult",
        targetIds: ["lab-1"],
      }).success,
    ).toBe(false);
  });
});
