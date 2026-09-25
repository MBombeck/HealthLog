/**
 * v1.15.18 — GET /api/medications/[id]/dose-history.
 *
 * The endpoint the medication "Verlauf" tab consumes. Pins the contract:
 *   - ownership-scoped (404 from the shared helper) + rate-limited (429);
 *   - reads only `deletedAt: null` rows;
 *   - returns the unified dose-history ledger (every expected slot with a
 *     status + ad-hoc takes), built from the SAME bands the compliance % uses,
 *     so the history view can never disagree with the rate;
 *   - serialises instants as ISO strings (iOS-safe additive shape).
 *
 * The band attribution itself is covered exhaustively by the pure-engine
 * suites (`band-minter` / `attribution` / `dose-history` / `attribute-intake`);
 * this file pins the route's wiring + envelope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findUnique: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/medications/route-guards", () => ({
  assertMedicationOwnership: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: vi.fn(() => ({ "X-RateLimit-Remaining": "0" })),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
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
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { localHmAsUtc } from "@/lib/tz/local-day";

const TZ = "Europe/Berlin";
const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    timezone: TZ,
  },
};

const ROUTE_PARAMS = { params: Promise.resolve({ id: "med-1" }) };

function getReq(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/medications/med-1/dose-history${query}`,
    { method: "GET" },
  );
}

function at(dayRef: Date, h: number, m: number): Date {
  return localHmAsUtc(dayRef, TZ, h, m);
}

const DAY = new Date("2026-06-05T12:00:00Z"); // a couple days in the past

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(assertMedicationOwnership).mockResolvedValue(null);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.medication.findUnique).mockResolvedValue({
    id: "med-1",
    startsOn: null,
    endsOn: null,
    oneShot: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    schedules: [
      {
        id: "sched-1",
        windowStart: "07:00",
        windowEnd: "07:00",
        daysOfWeek: null,
        timesOfDay: ["07:00", "19:00"],
        reminderGraceMinutes: null,
        rrule: null,
        rollingIntervalDays: null,
        scheduleType: "SCHEDULED",
        cyclicOnWeeks: null,
        cyclicOffWeeks: null,
      },
    ],
  } as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
});

describe("GET /api/medications/[id]/dose-history", () => {
  it("returns the 404 from the shared ownership helper", async () => {
    vi.mocked(assertMedicationOwnership).mockResolvedValueOnce(
      new Response(null, { status: 404 }) as never,
    );
    const res = await GET(getReq(), ROUTE_PARAMS);
    expect(res.status).toBe(404);
  });

  it("returns 429 when the per-user cap is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await GET(getReq(), ROUTE_PARAMS);
    expect(res.status).toBe(429);
  });

  it("reads only deletedAt:null rows", async () => {
    await GET(getReq(), ROUTE_PARAMS);
    const where = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.where;
    expect(where).toMatchObject({
      medicationId: "med-1",
      userId: "user-1",
      deletedAt: null,
    });
  });

  it("attributes an on-time take to its slot and orphans an off-window take", async () => {
    const from = at(DAY, 0, 0).toISOString();
    const to = at(DAY, 23, 59).toISOString();
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce([
      // on-time morning take
      {
        id: "evt-morning",
        scheduledFor: at(DAY, 7, 0),
        takenAt: at(DAY, 7, 5),
        skipped: false,
        autoMissed: false,
      },
      // off-window midday take (was the ±6h-snapped "07:00 dose")
      {
        id: "evt-adhoc",
        scheduledFor: at(DAY, 11, 29),
        takenAt: at(DAY, 11, 29),
        skipped: false,
        autoMissed: false,
      },
    ] as never);

    const res = await GET(
      getReq(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const rows = json.data.rows as Array<{
      kind: string;
      timeOfDay: string | null;
      status: string;
      intake: { id: string | null } | null;
    }>;

    // 07:00 slot taken on-time; 19:00 slot missed (it is in the past); the
    // midday take is ad-hoc, NOT snapped onto a slot.
    const morning = rows.find((r) => r.timeOfDay === "07:00");
    expect(morning?.status).toBe("taken_on_time");
    expect(morning?.intake?.id).toBe("evt-morning");

    const evening = rows.find((r) => r.timeOfDay === "19:00");
    expect(evening?.status).toBe("missed");

    const adHoc = rows.find((r) => r.kind === "ad_hoc");
    expect(adHoc?.status).toBe("ad_hoc");
    expect(adHoc?.intake?.id).toBe("evt-adhoc");
  });

  it("returns each intake's write provenance in `source` (iOS #64)", async () => {
    const from = at(DAY, 0, 0).toISOString();
    const to = at(DAY, 23, 59).toISOString();
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce([
      // a native-app take carries API provenance
      {
        id: "evt-morning",
        scheduledFor: at(DAY, 7, 0),
        takenAt: at(DAY, 7, 5),
        skipped: false,
        autoMissed: false,
        source: "API",
      },
      // a legacy row written before the column carried a value → null
      {
        id: "evt-adhoc",
        scheduledFor: at(DAY, 11, 29),
        takenAt: at(DAY, 11, 29),
        skipped: false,
        autoMissed: false,
        source: null,
      },
    ] as never);

    // The route must SELECT `source` from Prisma, or it could never surface it.
    const res = await GET(
      getReq(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(200);
    const select = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.select as Record<string, unknown> | undefined;
    expect(select?.source).toBe(true);

    const json = await res.json();
    const rows = json.data.rows as Array<{
      kind: string;
      timeOfDay: string | null;
      intake: { id: string | null; source: string | null } | null;
    }>;

    const morning = rows.find((r) => r.timeOfDay === "07:00");
    expect(morning?.intake?.id).toBe("evt-morning");
    expect(morning?.intake?.source).toBe("API");

    const adHoc = rows.find((r) => r.kind === "ad_hoc");
    expect(adHoc?.intake?.id).toBe("evt-adhoc");
    expect(adHoc?.intake?.source).toBe(null);
  });

  it("422 on a reversed from/to window", async () => {
    const from = at(DAY, 12, 0).toISOString();
    const to = at(DAY, 6, 0).toISOString();
    const res = await GET(
      getReq(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(422);
  });
});

/**
 * Issue #1028 — a dose logged for earlier today on a medication created later
 * the same day vanished from the trailing-window ledger while the full
 * history (which has no window) showed it. The window floor was clamped to
 * the medication's creation instant and the same clamped floor filtered the
 * intakes, so any dose recorded with a time before the moment the medication
 * was added fell out of "Last 90 days". The creation floor exists to keep
 * the ledger from minting phantom slots before the medication existed; it
 * says nothing about which recorded doses belong in the window.
 *
 * Pinned in a positive and a negative UTC offset so a zone-dependent floor
 * cannot hide behind one of them.
 */
describe("GET /api/medications/[id]/dose-history — intakes recorded before creation (#1028)", () => {
  for (const tz of ["Asia/Kolkata", "America/Los_Angeles"]) {
    it(`keeps a same-day dose logged before the medication was added (${tz})`, async () => {
      const today = new Date("2026-09-22T12:00:00Z");
      const now = localHmAsUtc(today, tz, 16, 30);
      const createdAt = localHmAsUtc(today, tz, 16, 20);
      const takenAt = localHmAsUtc(today, tz, 14, 0);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        vi.mocked(getSession).mockResolvedValue({
          ...SESSION_OK,
          user: { ...SESSION_OK.user, timezone: tz },
        } as never);
        vi.mocked(prisma.medication.findUnique).mockResolvedValue({
          id: "med-1",
          startsOn: null,
          endsOn: null,
          oneShot: false,
          createdAt,
          scheduleRevisions: [],
          schedules: [
            {
              id: "sched-1",
              windowStart: "08:00",
              windowEnd: "08:00",
              daysOfWeek: null,
              timesOfDay: ["08:00"],
              reminderGraceMinutes: null,
              rrule: null,
              rollingIntervalDays: null,
              scheduleType: "SCHEDULED",
              cyclicOnWeeks: null,
              cyclicOffWeeks: null,
            },
          ],
        } as never);
        vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
          {
            id: "evt-earlier-today",
            scheduledFor: takenAt,
            takenAt,
            skipped: false,
            autoMissed: false,
            attributionSource: "AUTO",
            doseTaken: null,
            source: "WEB",
          },
        ] as never);

        // Exactly what the Verlauf tab sends: the trailing 90 days to now.
        const from = new Date(now.getTime() - 90 * 86_400_000).toISOString();
        const to = now.toISOString();
        const res = await GET(
          getReq(
            `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          ),
          ROUTE_PARAMS,
        );
        expect(res.status).toBe(200);
        const json = await res.json();
        const ids = (
          json.data.rows as Array<{ intake: { id: string | null } | null }>
        ).map((r) => r.intake?.id);
        expect(ids).toContain("evt-earlier-today");
        // The response reports the window the recorded doses were read
        // over: the requested start, not the medication's creation.
        expect(json.data.from).toBe(from);
      } finally {
        vi.useRealTimers();
      }
    });
  }
});

describe("GET /api/medications/[id]/dose-history — early take (#1028 class)", () => {
  it("keeps a dose taken inside its window before the slot's own time", async () => {
    const tz = "Asia/Kolkata";
    const today = new Date("2026-09-22T12:00:00Z");
    const now = localHmAsUtc(today, tz, 19, 30);
    const slot = localHmAsUtc(today, tz, 20, 0);
    const takenAt = localHmAsUtc(today, tz, 19, 15);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      vi.mocked(getSession).mockResolvedValue({
        ...SESSION_OK,
        user: { ...SESSION_OK.user, timezone: tz },
      } as never);
      vi.mocked(prisma.medication.findUnique).mockResolvedValue({
        id: "med-1",
        startsOn: null,
        endsOn: null,
        oneShot: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        scheduleRevisions: [],
        schedules: [
          {
            id: "sched-1",
            windowStart: "20:00",
            windowEnd: "20:00",
            daysOfWeek: null,
            timesOfDay: ["20:00"],
            reminderGraceMinutes: null,
            rrule: null,
            rollingIntervalDays: null,
            scheduleType: "SCHEDULED",
            cyclicOnWeeks: null,
            cyclicOffWeeks: null,
          },
        ],
      } as never);
      vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
        {
          id: "evt-early",
          scheduledFor: slot,
          takenAt,
          skipped: false,
          autoMissed: false,
          attributionSource: "AUTO",
          doseTaken: null,
          source: "WEB",
        },
      ] as never);
      const from = new Date(now.getTime() - 90 * 86_400_000).toISOString();
      const res = await GET(
        getReq(`?from=${encodeURIComponent(from)}`),
        ROUTE_PARAMS,
      );
      const json = await res.json();
      const rows = json.data.rows as Array<{
        status: string;
        intake: { id: string | null } | null;
      }>;
      // `to` reports how far recorded doses were read: up to the early
      // dose's slot, past the request's own now.
      expect(json.data.to).toBe(slot.toISOString());
      const early = rows.find((r) => r.intake?.id === "evt-early");
      expect(early?.status).toBe("taken_on_time");
      // The read horizon stretches only to the recorded anchor: no later
      // slot is minted as upcoming.
      expect(rows.filter((r) => r.status === "upcoming")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * #1028 follow-up — a medication added in the afternoon, dosed 09:00 / 14:00
 * / 21:00. The 14:00 dose of the creation day was recorded afterwards on its
 * own slot, the 21:00 dose came in through the reminder, and the 09:00 slot
 * of that day only ever held the pending placeholder the today projector
 * mints for every slot of the day, which the auto-miss pass later stamped.
 *
 * The 14:00 dose must read as its own slot, taken on time, not as an
 * off-schedule take "due" at 21:00; the 09:00 slot, which predates the
 * medication and holds no recorded dose, must not appear at all.
 */
describe("GET /api/medications/[id]/dose-history — slots before creation (#1028)", () => {
  const cases = [
    { tz: "Asia/Kolkata", edited: false },
    { tz: "America/New_York", edited: false },
    // The schedule was saved again shortly after the medication was added,
    // so the creation day lives in an archived schedule era.
    { tz: "Asia/Kolkata", edited: true },
  ];
  for (const { tz, edited } of cases) {
    it(`attributes a recorded dose on a pre-creation slot and hides the unrecorded one (${tz}${edited ? ", edited schedule" : ""})`, async () => {
      const day1 = new Date("2026-09-23T12:00:00Z");
      const day2 = new Date("2026-09-24T12:00:00Z");
      const createdAt = localHmAsUtc(day1, tz, 16, 5);
      const now = localHmAsUtc(day2, tz, 22, 0);
      const d1 = (h: number, m = 0) => localHmAsUtc(day1, tz, h, m);
      const d2 = (h: number, m = 0) => localHmAsUtc(day2, tz, h, m);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        vi.mocked(getSession).mockResolvedValue({
          ...SESSION_OK,
          user: { ...SESSION_OK.user, timezone: tz },
        } as never);
        vi.mocked(prisma.medication.findUnique).mockResolvedValue({
          id: "med-1",
          startsOn: new Date("2026-09-23T00:00:00Z"),
          endsOn: new Date("2026-09-28T00:00:00Z"),
          oneShot: false,
          createdAt,
          scheduleRevisions: edited
            ? [
                {
                  id: "rev-1",
                  validFrom: createdAt,
                  validUntil: localHmAsUtc(day1, tz, 16, 30),
                  supersededByRevisionId: null,
                  payload: [
                    {
                      timesOfDay: ["09:00", "14:00", "21:00"],
                      windowStart: "09:00",
                      windowEnd: "09:00",
                      daysOfWeek: null,
                      rrule: null,
                      rollingIntervalDays: null,
                      scheduleType: "SCHEDULED",
                      cyclicOnWeeks: null,
                      cyclicOffWeeks: null,
                      doseWindows: null,
                      label: null,
                      dose: "1 tablet",
                      reminderGraceMinutes: null,
                    },
                  ],
                },
              ]
            : [],
          schedules: [
            {
              id: "sched-1",
              windowStart: "09:00",
              windowEnd: "09:00",
              daysOfWeek: null,
              timesOfDay: ["09:00", "14:00", "21:00"],
              reminderGraceMinutes: null,
              rrule: null,
              rollingIntervalDays: null,
              scheduleType: "SCHEDULED",
              cyclicOnWeeks: null,
              cyclicOffWeeks: null,
            },
          ],
        } as never);
        const row = (
          id: string,
          scheduledFor: Date,
          takenAt: Date | null,
          extra: Partial<{ autoMissed: boolean; source: string }> = {},
        ) => ({
          id,
          scheduledFor,
          takenAt,
          skipped: false,
          autoMissed: extra.autoMissed ?? false,
          attributionSource: "AUTO",
          doseTaken: null,
          source: extra.source ?? "REMINDER",
        });
        vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
          row("d2-2100", d2(21), d2(21, 30)),
          row("d2-1400", d2(14), d2(14)),
          row("d2-0900", d2(9), d2(10)),
          row("d1-2100", d1(21), d1(21)),
          row("d1-1400", d1(14), d1(14), { source: "WEB" }),
          // The projector's placeholder for the pre-creation 09:00 slot,
          // stamped by the auto-miss pass a day later.
          row("d1-0900-placeholder", d1(9), null, { autoMissed: true }),
        ] as never);

        const from = new Date(now.getTime() - 90 * 86_400_000).toISOString();
        const res = await GET(
          getReq(
            `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(now.toISOString())}`,
          ),
          ROUTE_PARAMS,
        );
        expect(res.status).toBe(200);
        const json = await res.json();
        const rows = json.data.rows as Array<{
          kind: string;
          at: string;
          timeOfDay: string | null;
          status: string;
          nearestSlot?: unknown;
          intake: { id: string | null } | null;
        }>;

        expect(
          rows.map((r) => [r.at, r.kind, r.status, r.intake?.id ?? null]),
        ).toEqual([
          [d1(14).toISOString(), "slot", "taken_on_time", "d1-1400"],
          [d1(21).toISOString(), "slot", "taken_on_time", "d1-2100"],
          [d2(9).toISOString(), "slot", "taken_on_time", "d2-0900"],
          [d2(14).toISOString(), "slot", "taken_on_time", "d2-1400"],
          [d2(21).toISOString(), "slot", "taken_on_time", "d2-2100"],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });
  }
});
