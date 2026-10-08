/**
 * The day/timeline contract's own rules (v1.42, #613): the enums mirror the
 * database, the life-event dates line up with their precision, and the day
 * index refuses a window wider than it promises to answer.
 */
import { describe, expect, it } from "vitest";

import {
  LifeEventCategory,
  LifeEventPrecision,
} from "@/generated/prisma/enums";

import {
  DAY_INDEX_MAX_SPAN_DAYS,
  DAY_SECTION_KEYS,
  LIFE_EVENT_CATEGORIES,
  LIFE_EVENT_PRECISIONS,
  MODEL_EXCLUDED_DAY_SECTIONS,
} from "../contract";
import {
  dayIndexQuerySchema,
  dayPathSchema,
  lifeEventCreateSchema,
  lifeEventUpdateSchema,
} from "../wire-schemas";

const event = {
  category: "HOME",
  startDate: "2023-09-01",
  precision: "MONTH",
  title: "Moved",
} as const;

describe("the contract mirrors the schema", () => {
  it("lists exactly the database's life-event categories and precisions", () => {
    expect([...LIFE_EVENT_CATEGORIES].sort()).toEqual(
      Object.values(LifeEventCategory).sort(),
    );
    expect([...LIFE_EVENT_PRECISIONS].sort()).toEqual(
      Object.values(LifeEventPrecision).sort(),
    );
  });

  it("keeps life events out of what a model sees", () => {
    expect(MODEL_EXCLUDED_DAY_SECTIONS).toContain("lifeEvents");
    for (const key of MODEL_EXCLUDED_DAY_SECTIONS) {
      expect(DAY_SECTION_KEYS).toContain(key);
    }
  });
});

describe("dates", () => {
  it("takes a real calendar date and refuses one that overflows", () => {
    expect(dayPathSchema.safeParse({ date: "2026-03-29" }).success).toBe(true);
    expect(dayPathSchema.safeParse({ date: "2026-02-30" }).success).toBe(false);
    expect(dayPathSchema.safeParse({ date: "2026-3-9" }).success).toBe(false);
  });

  it("answers a day index of at most the promised span", () => {
    const from = "2026-01-01";
    const last = new Date(Date.parse(`${from}T00:00:00Z`));
    last.setUTCDate(last.getUTCDate() + DAY_INDEX_MAX_SPAN_DAYS - 1);
    const to = last.toISOString().slice(0, 10);
    expect(dayIndexQuerySchema.safeParse({ from, to }).success).toBe(true);
    last.setUTCDate(last.getUTCDate() + 1);
    expect(
      dayIndexQuerySchema.safeParse({
        from,
        to: last.toISOString().slice(0, 10),
      }).success,
    ).toBe(false);
    expect(
      dayIndexQuerySchema.safeParse({ from: "2026-02-02", to: "2026-02-01" })
        .success,
    ).toBe(false);
  });
});

describe("a life event", () => {
  it("accepts a month-precise date on the first of the month", () => {
    expect(lifeEventCreateSchema.safeParse(event).success).toBe(true);
  });

  it("refuses a date that does not line up with its precision", () => {
    expect(
      lifeEventCreateSchema.safeParse({ ...event, startDate: "2023-09-14" })
        .success,
    ).toBe(false);
    expect(
      lifeEventCreateSchema.safeParse({
        ...event,
        precision: "YEAR",
        startDate: "2023-09-01",
      }).success,
    ).toBe(false);
    expect(
      lifeEventCreateSchema.safeParse({
        ...event,
        precision: "YEAR",
        startDate: "2019-01-01",
      }).success,
    ).toBe(true);
  });

  it("refuses an end before its start", () => {
    expect(
      lifeEventCreateSchema.safeParse({
        ...event,
        precision: "DAY",
        startDate: "2026-03-02",
        endDate: "2026-03-01",
      }).success,
    ).toBe(false);
  });

  it("refuses an empty title and an unknown key", () => {
    expect(
      lifeEventCreateSchema.safeParse({ ...event, title: "   " }).success,
    ).toBe(false);
    expect(
      lifeEventCreateSchema.safeParse({ ...event, userId: "someone-else" })
        .success,
    ).toBe(false);
    expect(
      lifeEventUpdateSchema.safeParse({ userId: "someone-else" }).success,
    ).toBe(false);
  });
});
