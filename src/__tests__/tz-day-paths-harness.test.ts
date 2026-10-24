/**
 * Core day paths under a host zone far from UTC.
 *
 * The suite pins the host to UTC (`vitest.config.mts`), and the production
 * image to Europe/Berlin. Both sit close enough to UTC that a UTC day and a
 * local day agree for most of every day, which is how day-boundary defects
 * kept passing: the evening west of UTC and the small hours east of it are
 * exactly the hours no fixture lived in. This harness sets the HOST zone
 * (`process.env.TZ`, in code; the `TZ=` prefix on the command line does not
 * reach Vitest's workers here) to one zone at each edge, gives the account
 * the same zone, and checks that a handful of the paths people hit name the
 * local day at the edge of it:
 *
 *   - a medication schedule slot, and a course on its last day
 *   - a mood entry's day
 *   - the dashboard summary's mood instant (the iOS home tile)
 *   - a document date from the stated string to the stored instant to the
 *     DTO
 *
 * Each zone is tested at the instant where its local day and the UTC day
 * differ: 23:30 in Los Angeles (already tomorrow in UTC) and 00:30 on
 * Kiritimati (still yesterday in UTC).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/modules/gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/modules/gate")>();
  return {
    ...actual,
    resolveModuleMap: vi.fn(async () =>
      Object.fromEntries(actual.MODULE_KEYS.map((k) => [k, true])),
    ),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { groupBy: vi.fn(), findMany: vi.fn() },
    medicationIntakeEvent: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      groupBy: vi.fn(),
    },
    medication: { findMany: vi.fn() },
    medicationScheduleRevision: { groupBy: vi.fn() },
    user: { findUnique: vi.fn() },
    appSettings: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(),
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));
vi.mock("@/lib/analytics/mood-series", () => ({
  buildMoodDailySeries: vi.fn(),
}));
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

import { GET as dashboardSummary } from "@/app/api/dashboard/summary/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { buildMoodDailySeries } from "@/lib/analytics/mood-series";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { serialiseDocument } from "@/lib/documents/store";
import { resolveIntakeActionability } from "@/lib/medications/intake-actionable";
import { moodDateKey } from "@/lib/mood/date-key";
import { dayKeyForScheduledFor } from "@/lib/medications/dose-day-refresh";
import {
  dateOnlyAtNoonUtc,
  dayKeyAsUtcMidnight,
  statedDateKey,
} from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";
import { localHmAsUtc } from "@/lib/tz/local-day";

interface EdgeCase {
  zone: string;
  /** An instant where the local day and the UTC day differ. */
  now: Date;
  /** The local calendar day at `now`. */
  localDay: string;
  /** The UTC calendar day at `now`, for the record. */
  utcDay: string;
}

const EDGES: EdgeCase[] = [
  {
    zone: "America/Los_Angeles",
    now: new Date("2026-07-03T06:30:00.000Z"), // 2 July, 23:30 local
    localDay: "2026-07-02",
    utcDay: "2026-07-03",
  },
  {
    zone: "Pacific/Kiritimati",
    now: new Date("2026-07-02T10:30:00.000Z"), // 3 July, 00:30 local
    localDay: "2026-07-03",
    utcDay: "2026-07-02",
  },
];

describe.each(EDGES)("day paths with the host in $zone", (edge) => {
  let previousTz: string | undefined;

  beforeAll(() => {
    previousTz = process.env.TZ;
    process.env.TZ = edge.zone;
  });
  afterAll(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it("runs with the host clock in the zone (the harness itself)", () => {
    // If the zone did not take, every assertion below would be testing UTC.
    expect(edge.now.getDate()).toBe(Number(edge.localDay.slice(8, 10)));
    expect(edge.localDay).not.toBe(edge.utcDay);
  });

  describe("medication schedule day", () => {
    it("keys a slot on the local day it falls on", () => {
      expect(dayKeyForScheduledFor(edge.now, edge.zone)).toBe(edge.localDay);
    });

    it("places today's 08:00 slot on the local day", () => {
      const slot = localHmAsUtc(edge.now, edge.zone, 8, 0);
      expect(userDayKey(slot, edge.zone)).toBe(edge.localDay);
    });

    it("keeps a course running through its last local day", () => {
      const status = resolveIntakeActionability(
        {
          active: true,
          trackIntake: true,
          startsOn: null,
          // `endsOn` is a @db.Date column: the calendar date as UTC midnight.
          endsOn: dayKeyAsUtcMidnight(edge.localDay),
          endedAt: null,
        },
        edge.now,
        edge.zone,
      );
      expect(status.courseStatus).toBe("CURRENT");
      expect(status.intakeActionable).toBe(true);
    });
  });

  describe("mood day", () => {
    it("files an entry under the local day it was logged", () => {
      expect(moodDateKey(edge.now, edge.zone)).toBe(edge.localDay);
    });
  });

  describe("dashboard summary day", () => {
    beforeEach(() => {
      vi.resetAllMocks();
      __resetAllCachesForTests();
      vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
      vi.mocked(prisma.measurement.groupBy).mockResolvedValue([] as never);
      vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
        [] as never,
      );
      vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.medicationIntakeEvent.createMany).mockResolvedValue({
        count: 0,
      } as never);
      vi.mocked(prisma.medicationIntakeEvent.groupBy).mockResolvedValue(
        [] as never,
      );
      vi.mocked(prisma.medicationScheduleRevision.groupBy).mockResolvedValue(
        [] as never,
      );
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        dateOfBirth: null,
        gender: null,
        heightCm: null,
      } as never);
      vi.mocked(getSession).mockResolvedValue({
        session: { id: "s", expiresAt: new Date(Date.now() + 3_600_000) },
        user: {
          id: "user-1",
          username: "tester",
          role: "USER",
          displayName: null,
          timezone: edge.zone,
        },
      } as never);
    });

    it("puts the mood card's instant on the entry's local day", async () => {
      vi.mocked(buildMoodDailySeries).mockResolvedValue({
        entries: [{ date: edge.localDay, score: 4, samples: 1 }],
        summary: null,
        entryCount: 1,
        source: "rollup",
      } as never);
      const call = dashboardSummary as unknown as (
        req: NextRequest,
      ) => Promise<Response>;
      const res = await call(
        new NextRequest("http://localhost/api/dashboard/summary"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { metrics: Array<{ kind: string; updatedAt: string | null }> };
      };
      const mood = body.data.metrics.find((m) => m.kind === "mood");
      expect(mood?.updatedAt).toBeTruthy();
      const at = new Date(mood!.updatedAt!);
      // Read the way a client in the zone reads it: the host clock and the
      // account zone agree here.
      expect(userDayKey(at, edge.zone)).toBe(edge.localDay);
      expect(
        `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`,
      ).toBe(edge.localDay);
    });
  });

  describe("document date round trip", () => {
    function documentRow(documentDate: Date) {
      return {
        id: "doc-1",
        userId: "user-1",
        kind: "OTHER",
        title: null,
        filename: "report.pdf",
        mimeType: "application/pdf",
        byteSize: 1,
        status: "STORED",
        providerType: null,
        reportDate: documentDate,
        documentDate,
        errorReason: null,
        lastIndexAttemptAt: null,
        lastIndexOutcome: null,
        sourceSystem: null,
        sourceId: null,
        createdAt: edge.now,
        updatedAt: edge.now,
      } as never;
    }

    it("reads a written-out date as the date it states", () => {
      // Parsed as local time in the host zone; read back in UTC this was the
      // previous day east of UTC.
      expect(statedDateKey("July 3, 2026")).toBe("2026-07-03");
      expect(statedDateKey("2026-07-03")).toBe("2026-07-03");
      expect(statedDateKey("2026-07-03T08:00:00+09:00")).toBe("2026-07-03");
    });

    it("stores a stated date and serves the same date back", () => {
      const stored = dateOnlyAtNoonUtc(edge.localDay);
      const dto = serialiseDocument(documentRow(stored), {
        factCount: 0,
        pendingCount: 0,
      });
      expect(dto.documentDate).toBe(edge.localDay);
      expect(dto.reportDate).toBe(edge.localDay);
    });

    it("serves a row written before the noon anchor on its date too", () => {
      const legacy = dayKeyAsUtcMidnight(edge.localDay);
      const dto = serialiseDocument(documentRow(legacy), {
        factCount: 0,
        pendingCount: 0,
      });
      expect(dto.documentDate).toBe(edge.localDay);
    });
  });
});
