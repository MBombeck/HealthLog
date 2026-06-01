/**
 * v1.5.0 — reminder-worker cadence integration tests.
 *
 * Pins the new contract that v1.5 ships: the reminder worker's
 * schedule-resolution path now routes through the canonical recurrence
 * engine at `src/lib/medications/scheduling/recurrence.ts` instead of
 * the home-grown weekday filter. The pre-existing `intervalWeeks`
 * bi-weekly bug (a Wed bi-weekly schedule fired every Wed instead of
 * every other Wed because `grep intervalWeeks src/lib/jobs/reminder-worker.ts`
 * returned zero hits) closes as a side effect of the rewire — the
 * canonical engine honours RRULE INTERVAL correctly.
 *
 * The tests exercise the worker's `scheduleEmitsInWindow` helper
 * directly with real Postgres rows. This is the exact function the
 * worker's per-tick schedule-resolution branch calls; testing it
 * against a real `MedicationSchedule` row that's been written and
 * read back gives us byte-for-byte fidelity with what the worker
 * actually sees, without the dispatcher / Telegram / APNs / phase-
 * math side effects.
 *
 * The one-shot lifecycle is tested through the actual POST intake
 * route so the active-flip hook is end-to-end verified.
 *
 * Test coverage map:
 *   1. Bi-weekly regression (RRULE INTERVAL=2) — the pre-v1.5 bug.
 *   2. Monthly RRULE.
 *   3. Quarterly RRULE.
 *   4. Rolling — re-anchors on intake.
 *   5. One-shot — active flips after intake.
 *   6. `endsOn` cap.
 *   7. Legacy `daysOfWeek` fallback with `intervalWeeks > 1`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
  scheduleEmitsInWindow,
} from "@/lib/medications/scheduling/worker-helpers";
import { localHmAsUtc } from "@/lib/timezone";

const TEST_USER_ID = "user-medication-cadence-worker";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// Side-effects on the create-intake hot path that the one-shot test
// exercises but doesn't care about — keep them inert so the test
// stays focused on the schedule-resolution + lifecycle contract.
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));
vi.mock("@/lib/rollups/medication-compliance-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/medication-compliance-rollups")
  >("@/lib/rollups/medication-compliance-rollups");
  return {
    ...actual,
    recomputeMedicationComplianceForEvent: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "cadence-worker",
      email: "cadence-worker@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

/**
 * Read a fresh medication-row + its schedules from the DB and return
 * a (canonicalSchedule, recurrenceCtx) pair so each test exercises
 * the same shape the worker reads on its tick.
 */
async function loadCanonical(medicationId: string): Promise<{
  schedules: ReturnType<typeof buildCanonicalSchedule>[];
  ctx: ReturnType<typeof buildRecurrenceContext>;
}> {
  const prisma = getPrismaClient();
  const med = await prisma.medication.findUniqueOrThrow({
    where: { id: medicationId },
    include: { schedules: true },
  });
  const lastIntake = await prisma.medicationIntakeEvent.findFirst({
    where: { medicationId, takenAt: { not: null } },
    orderBy: { takenAt: "desc" },
    select: { takenAt: true },
  });
  return {
    schedules: med.schedules.map((s) => buildCanonicalSchedule(s)),
    ctx: buildRecurrenceContext({
      medication: med,
      userTz: "Europe/Berlin",
      lastIntakeAt: lastIntake?.takenAt ?? null,
    }),
  };
}

/**
 * Compute the user-tz today bounds for an arbitrary "now" instant,
 * matching `getUserTodayBounds` in `src/lib/timezone.ts` so the test
 * window matches what the worker would build on that tick.
 */
// UTC midnight on the local calendar day that `now` falls within for `tz`.
// Mirrors the column convention for `startsOn`/`endsOn` (stored as
// `...T00:00:00.000Z` on the local calendar day). Deriving the day from
// the same timezone `todayBounds` uses keeps a one-shot's emit day inside
// the checked window regardless of wall-clock time — reading the UTC date
// instead drifts a day late in the UTC evening when the local zone has
// already rolled into the next calendar day.
function localCalendarMidnightUtc(now: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

function todayBounds(now: Date, tz: string): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  // Two-pass solver: build local-midnight as UTC then shift by the
  // tz offset at that instant.
  const offsetMin = (() => {
    const probe = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
    const probeParts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(probe);
    const get = (t: string): number =>
      Number(probeParts.find((p) => p.type === t)?.value ?? "0");
    let hour = get("hour");
    if (hour === 24) hour = 0;
    const asIfUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      hour,
      get("minute"),
      0,
    );
    return Math.round((asIfUtc - probe.getTime()) / 60_000);
  })();
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - offsetMin * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

// ────────────────────────────────────────────────────────────────────
// 1. Bi-weekly regression — the pre-v1.5 `intervalWeeks` bug closes
// ────────────────────────────────────────────────────────────────────

describe("bi-weekly RRULE — pre-v1.5 intervalWeeks regression closes", () => {
  it("emits on the anchor Wed, skips next Wed, emits again 2 weeks later", async () => {
    // 2026-06-03 (Wed) is the anchor. The RRULE says every other Wed.
    // Worker tick on Jun 03 → should emit.
    // Worker tick on Jun 10 (Wed, skip week) → should NOT emit.
    // Worker tick on Jun 17 (Wed, on week) → should emit.
    const prisma = getPrismaClient();
    const med = await prisma.medication.create({
      data: {
        userId: TEST_USER_ID,
        name: "Mounjaro",
        dose: "5mg",
        active: true,
        startsOn: new Date("2026-06-03T00:00:00.000Z"),
        schedules: {
          create: {
            windowStart: "08:00",
            windowEnd: "09:00",
            rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
            timesOfDay: ["08:00"],
          },
        },
      },
    });

    const { schedules, ctx } = await loadCanonical(med.id);
    const [schedule] = schedules;

    // Anchor week (Wed 03) — emits.
    const anchorBounds = todayBounds(
      new Date("2026-06-03T10:00:00.000Z"),
      "Europe/Berlin",
    );
    expect(
      scheduleEmitsInWindow(
        schedule,
        ctx,
        anchorBounds.start,
        anchorBounds.end,
      ),
    ).toBe(true);

    // Off week (Wed 10) — pre-v1.5 worker would have fired here (the
    // bug). Canonical engine correctly skips.
    const offBounds = todayBounds(
      new Date("2026-06-10T10:00:00.000Z"),
      "Europe/Berlin",
    );
    expect(
      scheduleEmitsInWindow(schedule, ctx, offBounds.start, offBounds.end),
    ).toBe(false);

    // On week again (Wed 17) — emits.
    const onBounds = todayBounds(
      new Date("2026-06-17T10:00:00.000Z"),
      "Europe/Berlin",
    );
    expect(
      scheduleEmitsInWindow(schedule, ctx, onBounds.start, onBounds.end),
    ).toBe(true);

    // Non-Wed day (Thu 18) — never emits.
    const nonWedBounds = todayBounds(
      new Date("2026-06-18T10:00:00.000Z"),
      "Europe/Berlin",
    );
    expect(
      scheduleEmitsInWindow(
        schedule,
        ctx,
        nonWedBounds.start,
        nonWedBounds.end,
      ),
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. Monthly
// ────────────────────────────────────────────────────────────────────

describe("monthly RRULE", () => {
  it("BYMONTHDAY=1 emits on the 1st of each month, nothing in between", async () => {
    const prisma = getPrismaClient();
    const med = await prisma.medication.create({
      data: {
        userId: TEST_USER_ID,
        name: "B12 shot",
        dose: "1mg",
        active: true,
        startsOn: new Date("2026-02-01T00:00:00.000Z"),
        schedules: {
          create: {
            windowStart: "08:00",
            windowEnd: "09:00",
            rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
            timesOfDay: ["08:00"],
          },
        },
      },
    });

    const { schedules, ctx } = await loadCanonical(med.id);
    const [schedule] = schedules;

    const months = [
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
    ] as const;
    for (const dayStr of months) {
      const b = todayBounds(
        new Date(`${dayStr}T10:00:00.000Z`),
        "Europe/Berlin",
      );
      expect(scheduleEmitsInWindow(schedule, ctx, b.start, b.end)).toBe(true);
    }

    // Random in-between day — does not emit.
    const noMatch = todayBounds(
      new Date("2026-02-15T10:00:00.000Z"),
      "Europe/Berlin",
    );
    expect(
      scheduleEmitsInWindow(schedule, ctx, noMatch.start, noMatch.end),
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. Quarterly (monthly INTERVAL=3)
// ────────────────────────────────────────────────────────────────────

describe("quarterly RRULE", () => {
  it("INTERVAL=3 emits 3 times across 9 months on the 15th", async () => {
    const prisma = getPrismaClient();
    const med = await prisma.medication.create({
      data: {
        userId: TEST_USER_ID,
        name: "Quarterly check",
        dose: "n/a",
        active: true,
        startsOn: new Date("2026-01-15T00:00:00.000Z"),
        schedules: {
          create: {
            windowStart: "08:00",
            windowEnd: "09:00",
            rrule: "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15",
            timesOfDay: ["08:00"],
          },
        },
      },
    });

    const { schedules, ctx } = await loadCanonical(med.id);
    const [schedule] = schedules;

    // Anchored at Jan 15 → next slots are Apr 15, Jul 15, Oct 15.
    const fires = ["2026-01-15", "2026-04-15", "2026-07-15"];
    for (const dayStr of fires) {
      const b = todayBounds(
        new Date(`${dayStr}T10:00:00.000Z`),
        "Europe/Berlin",
      );
      expect(scheduleEmitsInWindow(schedule, ctx, b.start, b.end)).toBe(true);
    }
    const misses = ["2026-02-15", "2026-03-15", "2026-05-15"];
    for (const dayStr of misses) {
      const b = todayBounds(
        new Date(`${dayStr}T10:00:00.000Z`),
        "Europe/Berlin",
      );
      expect(scheduleEmitsInWindow(schedule, ctx, b.start, b.end)).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// 4. Rolling — re-anchors on intake
// ────────────────────────────────────────────────────────────────────

describe("rolling cadence", () => {
  it("emits N days after the latest takenAt and re-anchors when a new intake is logged", async () => {
    const prisma = getPrismaClient();
    const med = await prisma.medication.create({
      data: {
        userId: TEST_USER_ID,
        name: "Wegovy",
        dose: "1mg",
        active: true,
        startsOn: new Date("2026-06-01T00:00:00.000Z"),
        schedules: {
          create: {
            windowStart: "08:00",
            windowEnd: "09:00",
            rollingIntervalDays: 7,
            timesOfDay: ["08:00"],
          },
        },
      },
    });

    // Initial intake on day 0 (2026-06-01).
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: med.id,
        scheduledFor: new Date("2026-06-01T06:00:00.000Z"),
        takenAt: new Date("2026-06-01T06:00:00.000Z"),
        skipped: false,
        source: "WEB",
      },
    });

    {
      // Day 7 (2026-06-08) — slot should land here.
      const { schedules, ctx } = await loadCanonical(med.id);
      const [schedule] = schedules;
      const day7 = todayBounds(
        new Date("2026-06-08T10:00:00.000Z"),
        "Europe/Berlin",
      );
      expect(scheduleEmitsInWindow(schedule, ctx, day7.start, day7.end)).toBe(
        true,
      );
      // Day 6 — too early.
      const day6 = todayBounds(
        new Date("2026-06-07T10:00:00.000Z"),
        "Europe/Berlin",
      );
      expect(scheduleEmitsInWindow(schedule, ctx, day6.start, day6.end)).toBe(
        false,
      );
    }

    // User takes early on day 5 (2026-06-06). Next slot should now
    // land on day 12 (2026-06-13), not day 14.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: med.id,
        scheduledFor: new Date("2026-06-06T06:00:00.000Z"),
        takenAt: new Date("2026-06-06T06:00:00.000Z"),
        skipped: false,
        source: "WEB",
      },
    });

    {
      const { schedules, ctx } = await loadCanonical(med.id);
      const [schedule] = schedules;
      // Day 12 (2026-06-13) → emits.
      const day12 = todayBounds(
        new Date("2026-06-13T10:00:00.000Z"),
        "Europe/Berlin",
      );
      expect(scheduleEmitsInWindow(schedule, ctx, day12.start, day12.end)).toBe(
        true,
      );
      // Day 11 — too early.
      const day11 = todayBounds(
        new Date("2026-06-12T10:00:00.000Z"),
        "Europe/Berlin",
      );
      expect(scheduleEmitsInWindow(schedule, ctx, day11.start, day11.end)).toBe(
        false,
      );
      // Day 14 — past the new anchor's slot; rolling only emits the
      // next slot, not future ones, so the window should miss.
      const day14 = todayBounds(
        new Date("2026-06-20T10:00:00.000Z"),
        "Europe/Berlin",
      );
      expect(scheduleEmitsInWindow(schedule, ctx, day14.start, day14.end)).toBe(
        false,
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// 5. One-shot — active flips after intake
// ────────────────────────────────────────────────────────────────────

describe("one-shot lifecycle", () => {
  it("mints the slot, the intake POST flips medication.active to false", async () => {
    const prisma = getPrismaClient();
    const today = new Date();
    const todayDate = localCalendarMidnightUtc(today, "Europe/Berlin");

    const med = await prisma.medication.create({
      data: {
        userId: TEST_USER_ID,
        name: "Flu shot 2026",
        dose: "0.5mL",
        active: true,
        oneShot: true,
        startsOn: todayDate,
        endsOn: todayDate,
        schedules: {
          create: {
            windowStart: "08:00",
            windowEnd: "09:00",
            timesOfDay: ["08:00"],
          },
        },
      },
    });

    // Schedule emits today.
    const { schedules, ctx } = await loadCanonical(med.id);
    const [schedule] = schedules;
    const bounds = todayBounds(today, "Europe/Berlin");
    expect(scheduleEmitsInWindow(schedule, ctx, bounds.start, bounds.end)).toBe(
      true,
    );

    // Log the intake via the real POST route to exercise the
    // active-flip hook end-to-end.
    const session = await prisma.session.create({
      data: {
        userId: TEST_USER_ID,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    cookieJar.set("healthlog_session", session.id);

    const { POST } = await import("@/app/api/medications/[id]/intake/route");
    const request = new NextRequest(
      `http://localhost/api/medications/${med.id}/intake`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          takenAt: new Date().toISOString(),
          skipped: false,
        }),
      },
    );
    const res = await POST(request, {
      params: Promise.resolve({ id: med.id }),
    });
    expect(res.status).toBe(201);

    const refreshed = await prisma.medication.findUniqueOrThrow({
      where: { id: med.id },
      select: { active: true },
    });
    expect(refreshed.active).toBe(false);
  });

  it("does NOT deactivate when the intake is skipped", async () => {
    const prisma = getPrismaClient();
    const today = new Date();
    const todayDate = localCalendarMidnightUtc(today, "Europe/Berlin");

    const med = await prisma.medication.create({
      data: {
        userId: TEST_USER_ID,
        name: "Flu shot keep-open",
        dose: "0.5mL",
        active: true,
        oneShot: true,
        startsOn: todayDate,
        endsOn: todayDate,
        schedules: {
          create: {
            windowStart: "08:00",
            windowEnd: "09:00",
            timesOfDay: ["08:00"],
          },
        },
      },
    });

    const session = await prisma.session.create({
      data: {
        userId: TEST_USER_ID,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    cookieJar.set("healthlog_session", session.id);

    const { POST } = await import("@/app/api/medications/[id]/intake/route");
    const request = new NextRequest(
      `http://localhost/api/medications/${med.id}/intake`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skipped: true }),
      },
    );
    const res = await POST(request, {
      params: Promise.resolve({ id: med.id }),
    });
    expect(res.status).toBe(201);

    const refreshed = await prisma.medication.findUniqueOrThrow({
      where: { id: med.id },
      select: { active: true },
    });
    expect(refreshed.active).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// 6. endsOn cap
// ────────────────────────────────────────────────────────────────────

describe("endsOn cap", () => {
  it("daily schedule with endsOn = startsOn + 3d emits on the 4 in-range days, no more", async () => {
    const prisma = getPrismaClient();
    const med = await prisma.medication.create({
      data: {
        userId: TEST_USER_ID,
        name: "Antibiotic 4-day course",
        dose: "500mg",
        active: true,
        startsOn: new Date("2026-06-01T00:00:00.000Z"),
        endsOn: new Date("2026-06-04T00:00:00.000Z"),
        schedules: {
          create: {
            windowStart: "08:00",
            windowEnd: "09:00",
            rrule: "FREQ=DAILY",
            timesOfDay: ["08:00"],
          },
        },
      },
    });

    const { schedules, ctx } = await loadCanonical(med.id);
    const [schedule] = schedules;

    // In-range days (Jun 01..04 in Berlin).
    const inRange = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"];
    for (const dayStr of inRange) {
      const b = todayBounds(
        new Date(`${dayStr}T10:00:00.000Z`),
        "Europe/Berlin",
      );
      expect(scheduleEmitsInWindow(schedule, ctx, b.start, b.end)).toBe(true);
    }

    // Out of range — no emit.
    const outOfRange = ["2026-06-05", "2026-06-10", "2026-06-30"];
    for (const dayStr of outOfRange) {
      const b = todayBounds(
        new Date(`${dayStr}T10:00:00.000Z`),
        "Europe/Berlin",
      );
      expect(scheduleEmitsInWindow(schedule, ctx, b.start, b.end)).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// 7. Legacy daysOfWeek fallback honours intervalWeeks
// ────────────────────────────────────────────────────────────────────

describe("legacy daysOfWeek fallback", () => {
  it("'i2;3' (bi-weekly Wed) behaves identically to the RRULE bi-weekly case", async () => {
    // Same shape as test 1 but with the legacy string instead of rrule.
    // This is the row shape pre-v1.5 migration would have left behind
    // if the rrule backfill missed; the engine's legacy path is the
    // safety net.
    const prisma = getPrismaClient();
    const med = await prisma.medication.create({
      data: {
        userId: TEST_USER_ID,
        name: "Mounjaro legacy",
        dose: "5mg",
        active: true,
        startsOn: new Date("2026-06-03T00:00:00.000Z"),
        schedules: {
          create: {
            windowStart: "08:00",
            windowEnd: "09:00",
            daysOfWeek: "i2;3",
            // rrule + rollingIntervalDays both NULL → legacy fallback
          },
        },
      },
    });

    const { schedules, ctx } = await loadCanonical(med.id);
    const [schedule] = schedules;

    // Anchor week — emits.
    const anchor = todayBounds(
      new Date("2026-06-03T10:00:00.000Z"),
      "Europe/Berlin",
    );
    expect(
      scheduleEmitsInWindow(schedule, ctx, anchor.start, anchor.end),
    ).toBe(true);
    // Off week (Wed 10) — pre-v1.5 worker would have fired (the bug);
    // the legacy path in the engine now honours intervalWeeks.
    const off = todayBounds(
      new Date("2026-06-10T10:00:00.000Z"),
      "Europe/Berlin",
    );
    expect(scheduleEmitsInWindow(schedule, ctx, off.start, off.end)).toBe(
      false,
    );
    // On week (Wed 17) — emits.
    const on = todayBounds(
      new Date("2026-06-17T10:00:00.000Z"),
      "Europe/Berlin",
    );
    expect(scheduleEmitsInWindow(schedule, ctx, on.start, on.end)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// 8. v1.8.2 — per-med intake POST collapses onto the canonical slot
// ────────────────────────────────────────────────────────────────────

describe("v1.8.2 per-med intake POST — source-agnostic slot collapse", () => {
  it("updates a pre-existing pending REMINDER slot row instead of inserting a second WEB row", async () => {
    const prisma = getPrismaClient();
    const med = await prisma.medication.create({
      data: {
        userId: TEST_USER_ID,
        name: "Bisoprolol",
        dose: "2.5mg",
        active: true,
        schedules: {
          create: {
            windowStart: "07:00",
            windowEnd: "07:00",
            timesOfDay: ["07:00"],
            daysOfWeek: null,
            scheduleType: "SCHEDULED",
          },
        },
      },
    });

    const slot = localHmAsUtc(new Date(), "Europe/Berlin", 7, 0);
    const pending = await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: med.id,
        scheduledFor: slot,
        takenAt: null,
        skipped: false,
        source: "REMINDER",
      },
    });

    const session = await prisma.session.create({
      data: {
        userId: TEST_USER_ID,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    cookieJar.set("healthlog_session", session.id);

    const { POST } = await import("@/app/api/medications/[id]/intake/route");
    // +1 minute drift between the iOS write and the server's localHmAsUtc.
    const drifted = new Date(slot.getTime() + 60_000);
    const res = await POST(
      new NextRequest(`http://localhost/api/medications/${med.id}/intake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scheduledFor: drifted.toISOString(),
          takenAt: drifted.toISOString(),
          skipped: false,
        }),
      }),
      { params: Promise.resolve({ id: med.id }) },
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string } };
    expect(json.data.id).toBe(pending.id); // updated the SAME row

    const rows = await prisma.medicationIntakeEvent.findMany({
      where: { userId: TEST_USER_ID, medicationId: med.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(pending.id);
    expect(rows[0]?.takenAt).not.toBeNull();
    expect(rows[0]?.scheduledFor.toISOString()).toBe(slot.toISOString());
  });
});
