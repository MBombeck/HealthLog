/**
 * `GET /api/medications/resolved-slots` (iOS #191): every scheduled dose of
 * the record's medications over a window in one request, from the same
 * ledger and resolver as the dose history and the today list.
 *
 *   - parity: each slot reads exactly what `dose-history` says over the same
 *     window, and today's slots what the today list says;
 *   - the medications that cannot be due (as-needed, paused, record-only)
 *     are not listed;
 *   - the window is bounded at 14 days;
 *   - the statement count does not grow with the number of medications.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cookieJar, headerJar } from "./mock-next-headers";
import { countStatements, summariseStatements } from "./query-counter";
import { getPrismaClient, truncateAllTables } from "./setup";
import { DAY_MS, TZ, readToday } from "./medication-dose-state-fixtures";

vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

// Saturday 08:10 in Berlin.
const NOW = new Date("2026-11-21T07:10:00.000Z");
const FROM = new Date(NOW.getTime() - 2 * DAY_MS);
const TO = new Date(NOW.getTime() + 8 * DAY_MS);

/**
 * Statements of one request on any fixture, whatever its number of
 * medications: auth and the rate limit, the medications with their
 * schedules, eras and courses, the ledgers' two intake reads and the read of
 * the takes' origin. Measured when written; lower it when a change needs
 * fewer, never raise it without the reason beside the number.
 */
const STATEMENT_BUDGET = 12;

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedUser() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "slots",
      email: "slots@example.test",
      role: "USER",
      timezone: TZ,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + DAY_MS) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

async function seedMedication(
  userId: string,
  name: string,
  schedule: {
    timesOfDay: string[];
    daysOfWeek?: string | null;
    rollingIntervalDays?: number | null;
  },
  extra: Record<string, unknown> = {},
) {
  return getPrismaClient().medication.create({
    data: {
      userId,
      name,
      dose: "1",
      active: true,
      startsOn: new Date(NOW.getTime() - 30 * DAY_MS),
      createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
      ...extra,
      schedules: {
        create: {
          windowStart: schedule.timesOfDay[0]!,
          windowEnd: schedule.timesOfDay.at(-1)!,
          timesOfDay: schedule.timesOfDay,
          daysOfWeek: schedule.daysOfWeek ?? null,
          rollingIntervalDays: schedule.rollingIntervalDays ?? null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
}

type Handler = (
  r: NextRequest,
  c: { params: Promise<Record<string, string>> },
) => Promise<Response>;

interface Slot {
  slotInstant: string;
  state: string;
  takenLate: boolean;
  dueAt: string;
  overdueSince: string;
  missedAfter: string;
  lateTakeCounts: boolean;
  takenAt: string | null;
  takenVia: string | null;
  intakeId: string | null;
  pinned: boolean;
}

async function resolvedSlots(query: Record<string, string>) {
  const { GET } = await import("@/app/api/medications/resolved-slots/route");
  const res = await (GET as unknown as (r: NextRequest) => Promise<Response>)(
    new NextRequest(
      `http://localhost/api/medications/resolved-slots?${new URLSearchParams(query)}`,
    ),
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      data: {
        from: string;
        to: string;
        medications: Array<{
          medicationId: string;
          family: string;
          slots: Slot[];
        }>;
      } | null;
    },
  };
}

async function doseHistory(medId: string) {
  const { GET } = await import("@/app/api/medications/[id]/dose-history/route");
  const q = new URLSearchParams({
    from: FROM.toISOString(),
    to: TO.toISOString(),
  });
  const res = await (GET as unknown as Handler)(
    new NextRequest(
      `http://localhost/api/medications/${medId}/dose-history?${q}`,
    ),
    { params: Promise.resolve({ id: medId }) },
  );
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      data: {
        family: string;
        rows: Array<{
          kind: string;
          at: string;
          state: string | null;
          takenLate: boolean;
          pinned?: boolean;
          intake: { id: string | null; takenAt: string | null } | null;
        }>;
      };
    }
  ).data;
}

const window = { from: FROM.toISOString(), to: TO.toISOString() };

describe("GET /api/medications/resolved-slots", () => {
  it("reads every slot as dose-history and the today list do", async () => {
    const user = await seedUser();
    const daily = await seedMedication(user.id, "Daily", {
      timesOfDay: ["08:00", "20:00"],
    });
    const weekly = await seedMedication(user.id, "Weekly", {
      timesOfDay: ["09:00"],
      daysOfWeek: "1,4",
    });
    const rolling = await seedMedication(user.id, "Every other week", {
      timesOfDay: ["07:30"],
      daysOfWeek: "i2;1,3,5",
    });
    const prisma = getPrismaClient();
    // Yesterday's morning dose taken late from the app, today's evening dose
    // skipped ahead, the every-other-week dose taken yesterday.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: daily.id,
        scheduledFor: new Date("2026-11-20T07:00:00.000Z"),
        takenAt: new Date("2026-11-20T10:30:00.000Z"),
        source: "API",
        takenVia: "APP",
      },
    });
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: daily.id,
        scheduledFor: new Date("2026-11-21T19:00:00.000Z"),
        skipped: true,
        source: "WEB",
      },
    });
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: rolling.id,
        scheduledFor: new Date("2026-11-20T06:30:00.000Z"),
        takenAt: new Date("2026-11-20T06:35:00.000Z"),
        source: "WEB",
        takenVia: "WEB",
      },
    });

    // The today list projects today's rows first, as a client's launch does.
    const today = (await readToday()) as unknown as Array<{
      id: string;
      medicationId: string;
      state: string | null;
      takenLate: boolean;
      slotInstant: string | null;
      dueAt: string | null;
      missedAfter: string | null;
      takenVia: string | null;
    }>;
    const { status, body } = await resolvedSlots(window);
    expect(status).toBe(200);
    const meds = body.data!.medications;
    expect(meds.map((m) => m.medicationId)).toEqual([
      daily.id,
      weekly.id,
      rolling.id,
    ]);

    for (const med of meds) {
      const history = await doseHistory(med.medicationId);
      expect(med.family).toBe(history.family);
      const expected = history.rows
        .filter(
          (r) =>
            r.kind === "slot" &&
            Date.parse(r.at) >= FROM.getTime() &&
            Date.parse(r.at) <= TO.getTime(),
        )
        .map((r) => ({
          slotInstant: r.at,
          state: r.state,
          takenLate: r.takenLate,
          pinned: r.pinned === true,
          intakeId: r.intake?.id ?? null,
          takenAt: r.intake?.takenAt ?? null,
        }));
      const name = {
        [daily.id]: "daily",
        [weekly.id]: "weekly",
        [rolling.id]: "every other week",
      }[med.medicationId];
      expect({
        name,
        history: expected.length,
        resolved: med.slots.length,
      }).toMatchObject({ history: expected.length, resolved: expected.length });
      expect(
        expected.length,
        `${name} has slots in the window`,
      ).toBeGreaterThan(0);
      expect(
        med.slots.map((s) => ({
          slotInstant: s.slotInstant,
          state: s.state,
          takenLate: s.takenLate,
          pinned: s.pinned,
          intakeId: s.intakeId,
          takenAt: s.state === "taken" ? s.takenAt : null,
        })),
      ).toEqual(
        expected.map((e) => ({
          ...e,
          takenAt: e.state === "taken" ? e.takenAt : null,
        })),
      );
    }

    // Today's slots read as the today list reads them.
    for (const row of today.filter((r) => r.slotInstant !== null)) {
      const slot = meds
        .find((m) => m.medicationId === row.medicationId)!
        .slots.find((s) => s.slotInstant === row.slotInstant)!;
      expect(slot).toMatchObject({
        intakeId: row.id,
        state: row.state,
        takenLate: row.takenLate,
        dueAt: row.dueAt,
        missedAfter: row.missedAfter,
        takenVia: row.takenVia,
      });
    }

    // The late take names where it came from.
    const late = meds[0]!.slots.find(
      (s) => s.slotInstant === "2026-11-20T07:00:00.000Z",
    );
    expect(late).toMatchObject({
      state: "taken",
      takenLate: true,
      takenVia: "APP",
    });
  });

  it("lists only medications that can be due", async () => {
    const user = await seedUser();
    const due = await seedMedication(user.id, "Due", { timesOfDay: ["08:00"] });
    await seedMedication(
      user.id,
      "Paused",
      { timesOfDay: ["08:00"] },
      { active: false },
    );
    await seedMedication(
      user.id,
      "Record only",
      { timesOfDay: ["08:00"] },
      { trackIntake: false },
    );
    await getPrismaClient().medication.create({
      data: { userId: user.id, name: "As needed", dose: "1", asNeeded: true },
    });
    const { body } = await resolvedSlots(window);
    expect(body.data!.medications.map((m) => m.medicationId)).toEqual([due.id]);
  });

  it("defaults to two days back and eight ahead, and bounds the window", async () => {
    await seedUser();
    const plain = await resolvedSlots({});
    expect(plain.status).toBe(200);
    expect(plain.body.data).toMatchObject({
      from: FROM.toISOString(),
      to: TO.toISOString(),
    });
    const tooLong = await resolvedSlots({
      from: FROM.toISOString(),
      to: new Date(FROM.getTime() + 15 * DAY_MS).toISOString(),
    });
    expect(tooLong.status).toBe(422);
    const backwards = await resolvedSlots({
      from: TO.toISOString(),
      to: FROM.toISOString(),
    });
    expect(backwards.status).toBe(422);
  });

  it("sends the same number of statements for one medication as for six", async () => {
    const user = await seedUser();
    await seedMedication(user.id, "One", { timesOfDay: ["08:00", "20:00"] });
    // Warm the process-level caches a running server already holds.
    await resolvedSlots(window);
    const one = await countStatements(() => resolvedSlots(window));
    for (let i = 0; i < 5; i += 1) {
      const med = await seedMedication(user.id, `More ${i}`, {
        timesOfDay: ["08:00", "20:00"],
        ...(i % 2 === 0 && { daysOfWeek: "1,3,5" }),
      });
      await getPrismaClient().medicationIntakeEvent.create({
        data: {
          userId: user.id,
          medicationId: med.id,
          scheduledFor: new Date("2026-11-20T07:00:00.000Z"),
          takenAt: new Date("2026-11-20T07:05:00.000Z"),
          source: "API",
          takenVia: "APP",
        },
      });
    }
    const six = await countStatements(() => resolvedSlots(window));
    expect(six.result.body.data!.medications).toHaveLength(6);
    expect(six.count, summariseStatements(six.statements)).toBe(one.count + 1);
    expect(six.count, summariseStatements(six.statements)).toBeLessThanOrEqual(
      STATEMENT_BUDGET,
    );
  });
});
