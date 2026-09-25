/**
 * `GET /api/cycle/calendar` — what a person logged on a day reaches the grid.
 *
 * The calendar used to carry flow, symptoms, BBT, the ovulation test and the
 * mucus reading, and nothing else from the day log. Intercourse, spotting, the
 * pregnancy and progesterone tests, contraception, the cervix signs and the
 * presence of a note were all dropped between the row and the wire, so a day
 * with only one of those logged looked exactly like a day with nothing logged.
 *
 * Same harness as the verdict round trip: the real exported `GET`, the real
 * builder, the real DTO mapping, the response read back as text. Two ends are
 * pinned — what the route asks Prisma for (a field that is not selected never
 * reaches the builder) and what comes back on the wire.
 *
 * The intent fields can sit in the encrypted envelope instead of the plaintext
 * columns (`sensitiveCategoryEncryption`), so one case writes them there and
 * expects the grid to read them just as the day-log read does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

vi.mock("@/lib/db", () => ({
  prisma: {
    menstrualCycle: { findMany: vi.fn() },
    cycleDayLog: { findMany: vi.fn() },
    measurement: { findMany: vi.fn() },
    cyclePrediction: { findUnique: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/cycle/gate", () => ({ requireCycleEnabled: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { encrypt } from "@/lib/crypto";
import { cycleCalendarDayDto } from "@/lib/openapi/routes/cycle";

function session() {
  return {
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
    user: {
      id: "user-1",
      username: "tester",
      role: "USER" as const,
      gender: "FEMALE",
      timezone: "UTC",
      locale: "en",
    },
  };
}

function profile() {
  return {
    userId: "user-1",
    goal: "GENERAL_HEALTH",
    typicalCycleLength: 28,
    typicalPeriodLength: 5,
    lutealPhaseLength: 14,
    predictionEnabled: true,
    rawChartMode: false,
    secondarySymptom: "MUCUS",
    cycleTrackingEnabled: true,
    sensitiveCategoryEncryption: false,
  };
}

/** A day-log row as Prisma returns it for the route's select. */
function logRow(date: string, over: Record<string, unknown> = {}) {
  return {
    date,
    flow: null,
    intermenstrualBleeding: false,
    basalBodyTempC: null,
    temperatureExcluded: false,
    ovulationTest: null,
    cervicalMucus: null,
    cervixPosition: null,
    cervixFirmness: null,
    cervixOpening: null,
    sexualActivity: false,
    protectedSex: null,
    pregnancyTest: null,
    progesteroneTest: null,
    contraceptive: null,
    sensitiveEncrypted: null,
    notesEncrypted: null,
    _count: { symptomLinks: 0 },
    ...over,
  };
}

async function callCalendar(): Promise<Record<string, unknown>[]> {
  const res = await GET(
    new NextRequest(
      "http://localhost/api/cycle/calendar?from=2026-09-01&to=2026-09-30",
    ),
  );
  expect(res.status).toBe(200);
  const body = JSON.parse(await res.text());
  return body.data.days as Record<string, unknown>[];
}

function day(days: Record<string, unknown>[], date: string) {
  const found = days.find((d) => d.date === date);
  if (!found) throw new Error(`no grid day ${date}`);
  return found;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  vi.mocked(getSession).mockResolvedValue(session() as never);
  vi.mocked(requireCycleEnabled).mockResolvedValue({
    enabled: true,
    profile: profile(),
  } as never);
  vi.mocked(prisma.menstrualCycle.findMany).mockResolvedValue([
    {
      id: "cyc-1",
      userId: "user-1",
      startDate: "2025-12-29",
      endDate: null,
      periodEndDate: null,
      ovulationDate: null,
      ovulationConfirmed: false,
      isPredicted: false,
    },
  ] as never);
  vi.mocked(prisma.cycleDayLog.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/cycle/calendar carries every per-day entry", () => {
  it("asks Prisma for the fields the grid now shows", async () => {
    await callCalendar();
    const args = vi.mocked(prisma.cycleDayLog.findMany).mock.calls[0][0] as {
      select: Record<string, unknown>;
    };
    expect(args.select).toMatchObject({
      intermenstrualBleeding: true,
      sexualActivity: true,
      pregnancyTest: true,
      progesteroneTest: true,
      contraceptive: true,
      sensitiveEncrypted: true,
      notesEncrypted: true,
      cervixPosition: true,
      cervixFirmness: true,
      cervixOpening: true,
    });
  });

  it("marks a day with intercourse logged, and only that day", async () => {
    vi.mocked(prisma.cycleDayLog.findMany).mockResolvedValue([
      logRow("2026-09-05", { sexualActivity: true }),
    ] as never);

    const days = await callCalendar();
    expect(day(days, "2026-09-05").sexualActivity).toBe(true);
    expect(day(days, "2026-09-04").sexualActivity).toBe(false);
    expect(day(days, "2026-09-06").sexualActivity).toBe(false);
  });

  it("reads intercourse and the tests from the encrypted envelope", async () => {
    // Encryption ON at write: the plaintext columns are NULL/false and the
    // envelope carries the values. The grid must read what the day log reads.
    vi.mocked(prisma.cycleDayLog.findMany).mockResolvedValue([
      logRow("2026-09-05", {
        sexualActivity: false,
        sensitiveEncrypted: encrypt(
          JSON.stringify({
            sexualActivity: true,
            protectedSex: true,
            pregnancyTest: "NEGATIVE",
            progesteroneTest: "POSITIVE",
            contraceptive: "ORAL",
          }),
        ),
      }),
    ] as never);

    const d = day(await callCalendar(), "2026-09-05");
    expect(d.sexualActivity).toBe(true);
    expect(d.pregnancyTest).toBe("NEGATIVE");
    expect(d.progesteroneTest).toBe("POSITIVE");
    expect(d.contraceptive).toBe("ORAL");
  });

  it("an undecryptable envelope reads as nothing logged, never a 500", async () => {
    vi.mocked(prisma.cycleDayLog.findMany).mockResolvedValue([
      logRow("2026-09-05", { sensitiveEncrypted: "v1:not-a-real-envelope" }),
    ] as never);

    const d = day(await callCalendar(), "2026-09-05");
    expect(d.sexualActivity).toBe(false);
    expect(d.pregnancyTest).toBeNull();
  });

  it("carries spotting, the cervix signs and whether a note exists", async () => {
    vi.mocked(prisma.cycleDayLog.findMany).mockResolvedValue([
      logRow("2026-09-10", {
        intermenstrualBleeding: true,
        cervixPosition: "HIGH",
        cervixFirmness: "SOFT",
        cervixOpening: "OPEN",
        notesEncrypted: encrypt("a note"),
      }),
    ] as never);

    const days = await callCalendar();
    const d = day(days, "2026-09-10");
    expect(d.intermenstrualBleeding).toBe(true);
    expect(d.cervixPosition).toBe("HIGH");
    expect(d.cervixFirmness).toBe("SOFT");
    expect(d.cervixOpening).toBe("OPEN");
    expect(d.hasNote).toBe(true);
    // The note's text never rides the grid, only its presence.
    expect(JSON.stringify(d)).not.toContain("a note");
    expect(day(days, "2026-09-11").hasNote).toBe(false);
  });

  it("every grid day carries exactly the fields the published contract names", async () => {
    // The contract promised the cervix signs while the route never sent them.
    // Pin the two against each other so neither can drift alone again.
    const days = await callCalendar();
    const contractKeys = Object.keys(cycleCalendarDayDto.shape).sort();
    expect(Object.keys(days[0]).sort()).toEqual(contractKeys);
  });
});
