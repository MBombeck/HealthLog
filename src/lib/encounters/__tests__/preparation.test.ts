import { describe, expect, it } from "vitest";

import type { EncounterKind } from "@/generated/prisma/client";
import { REPORT_MAX_RANGE_DAYS } from "@/lib/doctor-report-range";
import { daysBetweenDateKeys, shiftDateKey } from "@/lib/tz/format";
import {
  PREPARATION_DEFAULT_DAYS,
  resolvePreparation,
  specialtyKey,
  type PreparationVisit,
} from "../preparation";

const TZ = "Europe/Berlin";
const TODAY = "2026-10-21";

function visit(
  id: string,
  occurredAt: string,
  over: {
    kind?: EncounterKind;
    practitionerId?: string | null;
    name?: string;
    specialty?: string | null;
  } = {},
): PreparationVisit {
  const practitionerId =
    over.practitionerId === undefined ? null : over.practitionerId;
  return {
    id,
    occurredAt: new Date(occurredAt),
    kind: over.kind ?? "OTHER",
    practitionerId,
    practitioner: practitionerId
      ? { name: over.name ?? practitionerId, specialty: over.specialty ?? null }
      : null,
  };
}

const internist = (id: string, at: string) =>
  visit(id, at, {
    kind: "SPECIALIST",
    practitionerId: "p-int",
    name: "Internal practice",
    specialty: "Internal medicine",
  });

// The report from the issue: an internist a week ago, a dermatologist next.
const next = visit("next", "2026-10-23T08:00:00.000Z", {
  kind: "SPECIALIST",
  practitionerId: "p-derm",
  name: "Skin practice",
  specialty: "Dermatology",
});

function resolve(target: PreparationVisit, done: PreparationVisit[]) {
  return resolvePreparation({ next: target, done, tz: TZ, today: TODAY });
}

describe("the window before a booked visit", () => {
  it("starts at the last visit with the same practitioner", () => {
    const prep = resolve(next, [
      internist("int", "2026-10-16T09:00:00.000Z"),
      visit("derm", "2026-03-02T09:00:00.000Z", {
        kind: "SPECIALIST",
        practitionerId: "p-derm",
        name: "Skin practice",
        specialty: "Dermatology",
      }),
    ]);
    expect(prep).toEqual({
      from: "2026-03-02",
      to: "2026-10-23",
      basis: "practitioner",
      since: {
        id: "derm",
        occurredAt: "2026-03-02T09:00:00.000Z",
        kind: "SPECIALIST",
        practitionerName: "Skin practice",
        specialty: "Dermatology",
      },
      capped: false,
    });
  });

  it("else at the last visit in the same specialty, compared without case", () => {
    const prep = resolve(next, [
      internist("int", "2026-10-16T09:00:00.000Z"),
      visit("other-derm", "2025-11-20T09:00:00.000Z", {
        kind: "SPECIALIST",
        practitionerId: "p-derm-old",
        name: "Former skin practice",
        specialty: "  dermatology ",
      }),
    ]);
    expect(prep.basis).toBe("specialty");
    expect(prep.from).toBe("2025-11-20");
    expect(prep.since?.id).toBe("other-derm");
    expect(prep.since?.specialty).toBe("dermatology");
  });

  it("never falls back to the last visit of any kind", () => {
    // The issue: one week of internist data offered for the dermatologist.
    const prep = resolve(next, [internist("int", "2026-10-16T09:00:00.000Z")]);
    expect(prep).toEqual({
      from: "2026-07-23",
      to: "2026-10-23",
      basis: "default",
      since: null,
      capped: false,
    });
    expect(PREPARATION_DEFAULT_DAYS).toBe(90);
  });

  it("matches on kind only for a kind that names one line of care", () => {
    const therapy = visit("next-t", "2026-10-25T08:00:00.000Z", {
      kind: "THERAPY",
    });
    const done = [
      visit("acute", "2026-10-18T09:00:00.000Z", { kind: "ACUTE" }),
      visit("t1", "2026-10-11T09:00:00.000Z", { kind: "THERAPY" }),
    ];
    const prep = resolve(therapy, done);
    expect(prep.basis).toBe("kind");
    expect(prep.from).toBe("2026-10-11");

    // A specialist visit with no specialty says nothing about which one.
    const specialist = visit("next-s", "2026-10-25T08:00:00.000Z", {
      kind: "SPECIALIST",
    });
    expect(
      resolve(specialist, [
        visit("s1", "2026-10-11T09:00:00.000Z", { kind: "SPECIALIST" }),
      ]).basis,
    ).toBe("default");
    // Neither does "other", the kind nobody picked.
    const other = visit("next-o", "2026-10-25T08:00:00.000Z");
    expect(
      resolve(other, [visit("o1", "2026-10-11T09:00:00.000Z")]).basis,
    ).toBe("default");
  });

  it("prefers the practitioner over a newer visit in the same specialty", () => {
    const prep = resolve(next, [
      visit("derm-b", "2026-09-01T09:00:00.000Z", {
        kind: "SPECIALIST",
        practitionerId: "p-derm-b",
        specialty: "Dermatology",
      }),
      visit("derm-a", "2026-01-15T09:00:00.000Z", {
        kind: "SPECIALIST",
        practitionerId: "p-derm",
        specialty: "Dermatology",
      }),
    ]);
    expect(prep.basis).toBe("practitioner");
    expect(prep.since?.id).toBe("derm-a");
  });

  it("caps a window older than a report covers, still naming its visit", () => {
    const derm = (id: string, at: string) =>
      visit(id, at, {
        kind: "SPECIALIST",
        practitionerId: "p-derm",
        name: "Skin practice",
        specialty: "Dermatology",
      });
    const prep = resolve(next, [derm("old", "2023-04-03T09:00:00.000Z")]);
    expect(prep).toMatchObject({
      from: shiftDateKey("2026-10-23", -(REPORT_MAX_RANGE_DAYS - 1)),
      to: "2026-10-23",
      basis: "practitioner",
      capped: true,
      since: { id: "old", occurredAt: "2023-04-03T09:00:00.000Z" },
    });
    expect(daysBetweenDateKeys(prep.from, prep.to) + 1).toBe(
      REPORT_MAX_RANGE_DAYS,
    );
    // One day inside the limit is left as it is.
    const edge = shiftDateKey("2026-10-23", -(REPORT_MAX_RANGE_DAYS - 1));
    expect(
      resolve(next, [derm("edge", `${edge}T09:00:00.000Z`)]),
    ).toMatchObject({ from: edge, capped: false });
    expect(
      resolve(next, [derm("over", `${shiftDateKey(edge, -1)}T09:00:00.000Z`)]),
    ).toMatchObject({ from: edge, capped: true });
  });

  it("only counts visits before the booked one", () => {
    const later = visit("later", "2026-10-24T09:00:00.000Z", {
      practitionerId: "p-derm",
    });
    expect(resolve(next, [later]).basis).toBe("default");
  });

  it("starts on the matched visit's own day in the record's zone", () => {
    // 23:30 UTC is the next calendar day in Berlin.
    const prep = resolve(next, [
      visit("late", "2026-05-04T23:30:00.000Z", { practitionerId: "p-derm" }),
    ]);
    expect(prep.from).toBe("2026-05-05");
  });

  it("ends on the booked visit's own day in the record's zone, whatever the rule", () => {
    // 23:30 UTC on the 22nd is the 23rd in Berlin.
    const late = visit("late-next", "2026-10-22T23:30:00.000Z", {
      practitionerId: "p-derm",
    });
    expect(resolve(late, []).to).toBe("2026-10-23");
    expect(
      resolve(late, [
        visit("before", "2026-05-04T08:00:00.000Z", {
          practitionerId: "p-derm",
        }),
      ]).to,
    ).toBe("2026-10-23");
  });
});

describe("specialty comparison", () => {
  it("folds case and spacing, and nothing else", () => {
    expect(specialtyKey(" Internal  Medicine ")).toBe("internal medicine");
    expect(specialtyKey("")).toBeNull();
    expect(specialtyKey("   ")).toBeNull();
    expect(specialtyKey(null)).toBeNull();
    expect(specialtyKey("Dermatology")).not.toBe(specialtyKey("Skin doctor"));
  });
});
