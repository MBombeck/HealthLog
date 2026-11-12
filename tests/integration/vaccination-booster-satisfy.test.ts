/**
 * Logging a dose clears the boosters it answers — through the real route, real
 * Postgres, real reminder engine.
 *
 * Every property here is about ROWS: which `lastSatisfiedAt` moved, which did
 * not, and whether a reminder nobody keyed to an antigen was touched. None of
 * them can be answered by a mocked client, and the one that matters most is a
 * negative: a fake that ignored the `where` would report the ordinary Vorsorge
 * reminder as untouched while having satisfied it.
 *
 * The combination case is the reason this file exists. A Tdap dose has to
 * clear a tetanus booster AND a pertussis booster in one call, because a
 * reminder is keyed by an antigen and a dose is recorded as whatever
 * preparation the person was given. Matching the dose's own slug would leave
 * the tetanus booster standing.
 *
 * Fixture dates are relative. A fixed calendar date in a test about "older
 * than" and "moves forward" rots the moment it slides out of the window it
 * was written inside.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { POST as createVaccination } from "@/app/api/vaccinations/route";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

const OWNER_ID = "booster-owner";
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

async function seedSession() {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "booster-owner",
      email: "booster-owner@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: OWNER_ID,
      expiresAt: daysFromNow(7),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

/**
 * A booster reminder as the mint will write it: an ordinary ten-year VORSORGE
 * row that names the antigen a dose would settle.
 */
async function seedBooster(
  antigen: string | null,
  overrides: { lastSatisfiedAt?: Date | null; label?: string } = {},
) {
  return getPrismaClient().measurementReminder.create({
    data: {
      userId: OWNER_ID,
      label: overrides.label ?? `${antigen ?? "generic"} booster`,
      intervalDays: 3650,
      notifyHour: 9,
      vaccinationAntigen: antigen,
      lastSatisfiedAt: overrides.lastSatisfiedAt ?? null,
      nextDueAt: daysAgo(1),
    },
  });
}

function post(body: unknown): Promise<Response> {
  return createVaccination(
    new Request("http://localhost/api/vaccinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

async function reminderById(id: string) {
  return getPrismaClient().measurementReminder.findUniqueOrThrow({
    where: { id },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedSession();
});

describe("a dose satisfies the boosters it answers", () => {
  it("clears a monovalent antigen's own booster and re-anchors it", async () => {
    const reminder = await seedBooster("tetanus");
    const occurredAt = daysAgo(2);

    const res = await post({
      occurredAt: occurredAt.toISOString(),
      antigenSlug: "tetanus",
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);

    const after = await reminderById(reminder.id);
    // The start of the dose's calendar day in the person's zone.
    expect(after.lastSatisfiedAt).toEqual(
      startOfLocalDayKey(dateOnlyKey(occurredAt), "Europe/Berlin"),
    );
    // Re-anchored from the satisfy instant, so the next one lands roughly ten
    // years out rather than staying on the date it was already overdue on.
    expect(after.nextDueAt).not.toBeNull();
    expect(after.nextDueAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("records the satisfied reminder on the dose", async () => {
    const reminder = await seedBooster("tetanus");
    const res = await post({
      occurredAt: daysAgo(2).toISOString(),
      antigenSlug: "tetanus",
    });
    const payload = (await res.json()) as {
      data: { id: string; reminderId: string | null };
    };
    expect(payload.data.reminderId).toBe(reminder.id);
  });

  it("clears a tetanus AND a pertussis booster from one Tdap dose", async () => {
    // The property the whole component axis exists for. A matcher keyed on the
    // record's own slug would find neither of these.
    const tetanus = await seedBooster("tetanus");
    const pertussis = await seedBooster("pertussis");
    const occurredAt = daysAgo(3);

    const res = await post({
      occurredAt: occurredAt.toISOString(),
      antigenSlug: "tdap",
    });
    expect(res.status).toBe(201);

    expect((await reminderById(tetanus.id)).lastSatisfiedAt).not.toBeNull();
    expect((await reminderById(pertussis.id)).lastSatisfiedAt).not.toBeNull();
  });

  it("clears every component of a six-antigen infant dose", async () => {
    const reminders = await Promise.all(
      ["diphtheria", "tetanus", "pertussis", "polio", "hib", "hepatitis-b"].map(
        (antigen) => seedBooster(antigen),
      ),
    );

    const res = await post({
      occurredAt: daysAgo(1).toISOString(),
      antigenSlug: "hexavalent",
    });
    expect(res.status).toBe(201);

    const after = await Promise.all(
      reminders.map((reminder) => reminderById(reminder.id)),
    );
    expect(after.filter((row) => row.lastSatisfiedAt !== null)).toHaveLength(6);
  });
});

describe("what a dose must never touch", () => {
  it("leaves an ordinary Vorsorge reminder alone", async () => {
    // No antigen key at all — the blood-panel reminder somebody set years ago.
    // A matcher whose `where` did not hold would clear this and nothing in the
    // response would say so.
    const ordinary = await seedBooster(null, { label: "Blood panel" });

    const res = await post({
      occurredAt: daysAgo(1).toISOString(),
      antigenSlug: "tetanus",
    });
    expect(res.status).toBe(201);

    const after = await reminderById(ordinary.id);
    expect(after.lastSatisfiedAt).toBeNull();
    expect(after.nextDueAt?.toISOString()).toBe(
      ordinary.nextDueAt?.toISOString(),
    );
  });

  it("leaves a booster for an antigen the dose does not contain", async () => {
    const measles = await seedBooster("measles");

    const res = await post({
      occurredAt: daysAgo(1).toISOString(),
      antigenSlug: "tdap",
    });
    expect(res.status).toBe(201);
    expect((await reminderById(measles.id)).lastSatisfiedAt).toBeNull();
  });

  it("matches nothing at all for a free-text-only dose", async () => {
    // A name string is not evidence about which antigens were in the syringe.
    const tetanus = await seedBooster("tetanus");

    const res = await post({
      occurredAt: daysAgo(1).toISOString(),
      vaccineName: "Tetanus, as the 1987 Pass wrote it",
    });
    expect(res.status).toBe(201);

    const payload = (await res.json()) as {
      data: { reminderId: string | null };
    };
    expect(payload.data.reminderId).toBeNull();
    expect((await reminderById(tetanus.id)).lastSatisfiedAt).toBeNull();
  });

  it("leaves another account's booster alone", async () => {
    const prisma = getPrismaClient();
    await prisma.user.create({
      data: {
        id: "booster-stranger",
        username: "booster-stranger",
        email: "booster-stranger@example.test",
      },
    });
    const foreign = await prisma.measurementReminder.create({
      data: {
        userId: "booster-stranger",
        label: "tetanus booster",
        intervalDays: 3650,
        vaccinationAntigen: "tetanus",
        nextDueAt: daysAgo(1),
      },
    });

    const res = await post({
      occurredAt: daysAgo(1).toISOString(),
      antigenSlug: "tetanus",
    });
    expect(res.status).toBe(201);
    expect((await reminderById(foreign.id)).lastSatisfiedAt).toBeNull();
  });

  it("leaves a soft-deleted booster alone", async () => {
    const deleted = await seedBooster("tetanus");
    await getPrismaClient().measurementReminder.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });

    const res = await post({
      occurredAt: daysAgo(1).toISOString(),
      antigenSlug: "tetanus",
    });
    expect(res.status).toBe(201);
    expect((await reminderById(deleted.id)).lastSatisfiedAt).toBeNull();
  });
});

describe("the two properties the engine brings with it", () => {
  it("is forward-only: a backdated transcription never clears a due booster", async () => {
    // The property that makes bulk back-entry of an old Pass safe. The
    // reminder was satisfied a month ago; a page from 1987 must not move it.
    const satisfiedAt = daysAgo(30);
    const reminder = await seedBooster("tetanus", {
      lastSatisfiedAt: satisfiedAt,
    });

    const res = await post({
      occurredAt: daysAgo(14000).toISOString(),
      antigenSlug: "tetanus",
    });
    expect(res.status).toBe(201);

    const after = await reminderById(reminder.id);
    expect(after.lastSatisfiedAt?.toISOString()).toBe(
      satisfiedAt.toISOString(),
    );
    // And the record says so: no reminder was satisfied, so none is recorded.
    const payload = (await res.json()) as {
      data: { reminderId: string | null };
    };
    expect(payload.data.reminderId).toBeNull();
  });

  it("is idempotent: logging the same dose twice moves nothing the second time", async () => {
    const reminder = await seedBooster("tetanus");
    const occurredAt = daysAgo(5);
    const bodyIn = {
      occurredAt: occurredAt.toISOString(),
      antigenSlug: "tetanus",
    };

    expect((await post(bodyIn)).status).toBe(201);
    const afterFirst = await reminderById(reminder.id);

    // A duplicate entry is still a valid dose — two doses on one day happen —
    // so it returns 201. What must not happen is the reminder advancing again.
    const second = await post(bodyIn);
    expect(second.status).toBe(201);

    const afterSecond = await reminderById(reminder.id);
    expect(afterSecond.lastSatisfiedAt?.toISOString()).toBe(
      afterFirst.lastSatisfiedAt?.toISOString(),
    );
    expect(afterSecond.nextDueAt?.toISOString()).toBe(
      afterFirst.nextDueAt?.toISOString(),
    );
    const payload = (await second.json()) as {
      data: { reminderId: string | null };
    };
    expect(
      payload.data.reminderId,
      "the second dose satisfied nothing, so it records nothing",
    ).toBeNull();
  });

  it("leaves a reminder due when the dose is too old to have settled it", async () => {
    // Re-anchoring from an old instant can land the next due date in the past,
    // and that is correct: an old dose does not silence a real gap.
    const reminder = await seedBooster("tetanus");

    const res = await post({
      occurredAt: daysAgo(5000).toISOString(),
      antigenSlug: "tetanus",
    });
    expect(res.status).toBe(201);

    const after = await reminderById(reminder.id);
    expect(after.lastSatisfiedAt).not.toBeNull();
    expect(
      after.nextDueAt!.getTime(),
      "a dose from fourteen years ago on a ten-year cadence is still overdue",
    ).toBeLessThan(Date.now());
  });
});
