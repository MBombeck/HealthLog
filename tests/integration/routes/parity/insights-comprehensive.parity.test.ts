/**
 * Parity for `GET /api/insights/comprehensive` while the overview builder
 * moves out of the route into `src/lib/insights/`.
 *
 * One account with a full record (see `record-fixture.ts`) walks through the
 * cases the route tells apart, in order, each request seeing the cache the
 * earlier ones filled: an anonymous call, the overview cold, warm, and stale
 * after a measurement write (served while one rebuild runs behind it), the
 * `ai` block after the AI analysis opt-out and after the operator's master
 * switch (both off the cached body), a delegate with MANAGE access reading
 * the record cold, one with READ access refused, and the shared analytics
 * read ceiling. A second account in a zone west of UTC carries the sparse
 * shapes: mood entries with no rollup tier behind them, pulse without a
 * resting series, a medication with no schedule, an as-needed one, and no
 * height. An account with no data closes the walk.
 *
 * The clock is pinned (`Date` only) to noon of a fixed day
 * (`FIXED_ANCHOR_DAY`); every window the aggregator cuts, in JS and in SQL,
 * counts from that clock. The record leaves out its measurements on the 7th,
 * 30th and 60th day back, from when the aggregator cut those windows against
 * the database clock; the snapshot was recorded so. Every instant and day key
 * in the snapshot is written relative to the start of the day.
 *
 * The rollup refreshes the route starts and does not await are recorded
 * instead of run; the record's rollups are built once before the walk.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/insights/comprehensive/route";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";

import { anonymous, callRoute, type RouteAuth } from "../../../kit/call-route";
import {
  makeGrant,
  makeSession,
  makeUser,
  type SessionFixture,
} from "../../../kit/factories";
import {
  effectRecorder,
  eventFacts,
  expectParity,
  FIXED_ANCHOR_DAY,
  relativeToAnchor,
  stable,
  wideEventRecorder,
} from "../../../kit/parity";
import {
  getPrismaClient,
  switchSessionTo,
  truncateAllTables,
} from "../../setup";
import { parityId, seedParityRecord } from "./record-fixture";

vi.mock("@/lib/logging/transports", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/logging/transports")>();
  const { wideEventRecorder: recorder } = await import("../../../kit/parity");
  return {
    ...actual,
    emitIfSampled: (event: (typeof recorder.events)[number]) => {
      recorder.events.push(event);
    },
  };
});

vi.mock("@/lib/rollups/measurement-rollups", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rollups/measurement-rollups")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    ensureUserRollupsFresh: async (...args: unknown[]) => {
      effectRecorder.record("ensureUserRollupsFresh", args);
    },
  };
});

vi.mock("@/lib/rollups/mood-rollups", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rollups/mood-rollups")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    ensureUserMoodRollupsFresh: async (...args: unknown[]) => {
      effectRecorder.record("ensureUserMoodRollupsFresh", args);
    },
  };
});

const prisma = getPrismaClient();
const DAY = 86_400_000;
const ANCHOR = FIXED_ANCHOR_DAY;
const NOW = new Date(ANCHOR.getTime() + 12 * 60 * 60 * 1000);
/** Days back the record leaves out (see the header). */
const EDGE_DAYS = [7, 30, 60];

const OWNER_ID = parityId("insightscomp", 1);
const SPARSE_ID = parityId("insightscomp", 2);
const EMPTY_ID = parityId("insightscomp", 3);
const MANAGER_ID = parityId("insightscomp", 4);
const READER_ID = parityId("insightscomp", 5);

let owner: SessionFixture;
let sparse: RouteAuth;
let empty: RouteAuth;
let manager: SessionFixture;
let reader: SessionFixture;

/**
 * Keys of the aggregator's per-phase timings, which the clock and the load
 * decide. Their presence is kept, their value is not.
 */
function timingKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => timingKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/_ms$/.test(k)) out.add(k);
      timingKeys(v, out);
    }
  }
  return out;
}

/**
 * A stale serve starts one rebuild and returns without waiting for it. The
 * rebuild annotates the request's event too, and whether it gets there before
 * the event is emitted is a race between two sets of queries. On that case
 * only the cache outcome is kept, which the route decides alone.
 */
function cacheFactsOnly(facts: unknown): unknown {
  const f = facts as { meta?: Record<string, unknown> | null };
  const meta = Object.fromEntries(
    Object.entries(f.meta ?? {}).filter(([k]) => k.startsWith("cache.")),
  );
  return { ...f, action: "<raced>", meta };
}

/**
 * The aggregator's sub-queries run in parallel and annotate as each one
 * finishes, so the order of their keys in the event follows the database, not
 * the code. The keys are sorted; what they hold is unchanged.
 */
function sortedMeta(facts: unknown): unknown {
  const f = facts as { meta?: Record<string, unknown> | null };
  if (!f.meta) return facts;
  const meta = Object.fromEntries(
    Object.entries(f.meta).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return { ...f, meta };
}

async function step(
  name: string,
  options: { auth?: RouteAuth; raced?: boolean } = {},
): Promise<void> {
  wideEventRecorder.take();
  effectRecorder.take();
  const res = await callRoute(GET, {
    method: "GET",
    route: "/api/insights/comprehensive",
    auth: options.auth ?? owner,
  });
  // A stale serve leaves one rebuild running; it finishes before the
  // snapshot so the next case starts from the same cache.
  await settleBackgroundTasks();
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  const facts = events
    .map(eventFacts)
    .map(sortedMeta)
    .map((f) => (options.raced ? cacheFactsOnly(f) : f));
  await expectParity(
    `insights-comprehensive.${name}`,
    stable(
      relativeToAnchor(
        {
          status: res.status,
          body: res.body,
          events: facts,
          effects: effectRecorder.take(),
        },
        ANCHOR,
      ),
      { since: NOW, volatileKeys: [...timingKeys(facts)] },
    ),
  );
}

/** Remove the record's measurements on the SQL window edge days. */
async function dropEdgeDays(userId: string): Promise<void> {
  for (const d of EDGE_DAYS) {
    await prisma.measurement.deleteMany({
      where: {
        userId,
        measuredAt: {
          gte: new Date(ANCHOR.getTime() - d * DAY),
          lt: new Date(ANCHOR.getTime() - (d - 1) * DAY),
        },
      },
    });
  }
}

/** Mood without rollups, pulse without a resting series, odd medications. */
async function seedSparseRecord(userId: string): Promise<void> {
  const at = (d: number, hh: number, mm = 0) =>
    new Date(ANCHOR.getTime() - d * DAY + (hh * 60 + mm) * 60_000);
  const rows = [];
  for (let d = 1; d < 50; d++) {
    if (EDGE_DAYS.includes(d)) continue;
    rows.push(
      {
        userId,
        type: "WEIGHT" as const,
        value: 70 + (d % 5) * 0.3,
        unit: "kg",
        measuredAt: at(d, 3, 30),
      },
      {
        userId,
        type: "BLOOD_PRESSURE_SYS" as const,
        // Higher on the days the morning dose was skipped, so the
        // continuity correlation has something to find.
        value: 131 + ((d * 3) % 11) + (d % 5 === 0 ? 22 : 0),
        unit: "mmHg",
        measuredAt: at(d, 4, 10),
      },
      {
        userId,
        type: "BLOOD_PRESSURE_DIA" as const,
        value: 84 + ((d * 2) % 7),
        unit: "mmHg",
        measuredAt: at(d, 4, 10),
      },
      {
        userId,
        type: "PULSE" as const,
        value: 66 + (d % 9),
        unit: "bpm",
        measuredAt: at(d, 4, 0),
      },
      {
        userId,
        type: "PULSE" as const,
        value: 92 + (d % 5),
        unit: "bpm",
        measuredAt: at(d, 18, 0),
      },
      {
        userId,
        type: "PULSE" as const,
        value: 78 + (d % 7),
        unit: "bpm",
        measuredAt: at(d, 15, 0),
      },
    );
  }
  await prisma.measurement.createMany({ data: rows });
  const moods = ["LAUSIG", "SCHLECHT", "OKAY", "GUT", "SUPER_GUT"];
  const moodRows = [];
  for (let d = 1; d < 30; d++) {
    const loggedAt = at(d, 2, 15);
    const score = 1 + ((d * 2) % 5);
    moodRows.push({
      userId,
      // 02:15 UTC is the evening before in Bogotá.
      date: new Date(loggedAt.getTime() - 5 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      mood: moods[score - 1],
      score,
      moodLoggedAt: loggedAt,
      tz: "America/Bogota",
      createdAt: loggedAt,
    });
  }
  await prisma.moodEntry.createMany({ data: moodRows });
  const created = new Date(ANCHOR.getTime() - 60 * DAY);
  await prisma.medication.create({
    data: {
      id: parityId("insightscompmed", 1),
      userId,
      name: "Amlodipine",
      dose: "5mg",
      createdAt: created,
      schedules: {
        create: [
          {
            id: parityId("insightscompsch", 1),
            windowStart: "07:00",
            windowEnd: "09:00",
          },
        ],
      },
      categoryAssignment: { create: { category: "BLOOD_PRESSURE" } },
    },
  });
  await prisma.medication.create({
    data: {
      id: parityId("insightscompmed", 2),
      userId,
      name: "No schedule",
      dose: "1 tab",
      createdAt: created,
    },
  });
  await prisma.medication.create({
    data: {
      id: parityId("insightscompmed", 3),
      userId,
      name: "Ibuprofen",
      dose: "400mg",
      asNeeded: true,
      createdAt: created,
    },
  });
  const intakes = [];
  for (let d = 1; d <= 40; d++) {
    if (d % 4 === 0 || EDGE_DAYS.includes(d)) continue;
    intakes.push({
      id: parityId("insightscompie", d),
      userId,
      medicationId: parityId("insightscompmed", 1),
      scheduledFor: at(d, 12, 0),
      takenAt: d % 5 === 0 ? null : at(d, 12, 30),
      skipped: d % 5 === 0,
      createdAt: at(d, 12, 0),
    });
  }
  await prisma.medicationIntakeEvent.createMany({ data: intakes });
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  __resetAllCachesForTests();
  const ownerRow = await makeUser({
    id: OWNER_ID,
    timezone: "UTC",
    locale: "en",
    heightCm: 178,
    dateOfBirth: new Date("1975-04-02T00:00:00.000Z"),
    gender: "male",
    aiProvider: "ANTHROPIC",
    aiModel: "claude-sonnet-4-6",
    // Presence only: the overview never decrypts a key.
    aiAnthropicKeyEncrypted: "v1:presence-only",
  });
  await prisma.consentReceipt.create({
    data: {
      userId: OWNER_ID,
      kind: "ai_full",
      artefact: "test",
      signedAt: NOW,
    },
  });
  await seedParityRecord({ userId: OWNER_ID, now: NOW, tz: "UTC", tag: "ic" });
  await dropEdgeDays(OWNER_ID);
  const rollups = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  await rollups.ensureUserRollupsFresh(OWNER_ID);
  const moodRollups = await vi.importActual<
    typeof import("@/lib/rollups/mood-rollups")
  >("@/lib/rollups/mood-rollups");
  await moodRollups.ensureUserMoodRollupsFresh(OWNER_ID);
  await settleBackgroundTasks();
  owner = await makeSession(ownerRow);

  const sparseRow = await makeUser({
    id: SPARSE_ID,
    timezone: "America/Bogota",
    locale: "de",
    dateOfBirth: new Date("1950-08-20T00:00:00.000Z"),
  });
  await seedSparseRecord(SPARSE_ID);
  // Measurement rollups only: the mood tier stays empty on purpose.
  await rollups.ensureUserRollupsFresh(SPARSE_ID);
  await settleBackgroundTasks();
  sparse = await makeSession(sparseRow);

  const emptyRow = await makeUser({ id: EMPTY_ID, timezone: "UTC" });
  empty = await makeSession(emptyRow);

  const managerRow = await makeUser({ id: MANAGER_ID, timezone: "UTC" });
  await makeGrant(ownerRow, managerRow, { access: "MANAGE" });
  manager = await makeSession(managerRow);
  await switchSessionTo(manager.sessionId, OWNER_ID);

  const readerRow = await makeUser({ id: READER_ID, timezone: "UTC" });
  await makeGrant(ownerRow, readerRow, { access: "READ" });
  reader = await makeSession(readerRow);
  await switchSessionTo(reader.sessionId, OWNER_ID);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("GET /api/insights/comprehensive parity", () => {
  it("01 an anonymous call", async () => {
    await step("01-anonymous", { auth: anonymous });
  });

  it("02 the overview, cold", async () => {
    await step("02-cold");
  });

  it("03 the overview, warm", async () => {
    await step("03-warm");
  });

  it("04 the overview, stale after a measurement write", async () => {
    invalidateUserMeasurements(OWNER_ID);
    await step("04-stale", { raced: true });
  });

  it("05 the ai block after the AI analysis opt-out", async () => {
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: { modulePreferencesJson: { insights: false } },
    });
    await step("05-ai-analysis-off");
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: { modulePreferencesJson: {} },
    });
  });

  it("06 the ai block with the operator's master switch off", async () => {
    await prisma.appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", assistantEnabled: false },
      update: { assistantEnabled: false },
    });
    await step("06-operator-off");
    await prisma.appSettings.update({
      where: { id: "singleton" },
      data: { assistantEnabled: true },
    });
  });

  it("07 a delegate with MANAGE access, cold", async () => {
    __resetAllCachesForTests();
    await step("07-manage-delegate", { auth: manager });
  });

  it("08 a delegate with READ access", async () => {
    await step("08-read-delegate", { auth: reader });
  });

  it("09 the shared analytics read ceiling", async () => {
    await prisma.$executeRaw`
      INSERT INTO rate_limits (key, count, reset_at)
      VALUES (${`analytics-read:${OWNER_ID}`}, 100000, (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 hour')
      ON CONFLICT (key) DO UPDATE SET count = 100000`;
    await step("09-rate-limited");
    await prisma.$executeRaw`DELETE FROM rate_limits WHERE key = ${`analytics-read:${OWNER_ID}`}`;
  });

  it("10 a sparse record west of UTC", async () => {
    await step("10-sparse", { auth: sparse });
  });

  it("11 an account with no data", async () => {
    await step("11-empty", { auth: empty });
  });
});
