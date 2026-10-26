/**
 * Parity for `GET /api/analytics` while the response builder moves out of
 * the route into `src/lib/analytics/response/`.
 *
 * One account with a full record (see `record-fixture.ts`) walks through the
 * cases the route tells apart, in order, each request seeing the cache the
 * earlier ones filled: a `slice` outside the closed set, the summaries slice
 * cold and warm, the default body cold and warm, the summaries slice after
 * the glucose, sleep and recovery modules were switched off (gated after the
 * cache read), and the default body in another language with a personal
 * blood-pressure target (a fresh cache cell, so the builder runs against the
 * clinical band a second time and with glucose off). An account with no
 * profile and no data, and an anonymous call, close the walk. After each
 * request the snapshot holds the response and its cache header, the wide
 * event, the rollup refreshes the request handed off, and the stored health
 * scores and correlation patterns.
 *
 * The clock is pinned (`Date` only) to noon of a fixed day; see `NOW`. The
 * record's rollups are built once
 * before the walk; the fire-and-forget refresh the route starts on every
 * request is recorded instead of run, so the wide event never depends on
 * whether it finished first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/analytics/route";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";

import { anonymous, callRoute, type RouteAuth } from "../../../kit/call-route";
import { makeSession, makeUser } from "../../../kit/factories";
import {
  effectRecorder,
  eventFacts,
  expectParity,
  FIXED_ANCHOR_DAY,
  relativeToAnchor,
  stable,
  wideEventRecorder,
} from "../../../kit/parity";
import { getPrismaClient, truncateAllTables } from "../../setup";
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

const prisma = getPrismaClient();
/**
 * Noon of a fixed day. Every window the route cuts, in JS and in SQL, counts
 * from the request's clock, which the pin reaches, so the walk reads the same
 * at any hour and on any date it runs; the weekday-keyed figures need the
 * fixed date (`FIXED_ANCHOR_DAY`). The snapshot records positions relative to
 * the day's start (`relativeToAnchor`).
 */
const ANCHOR = FIXED_ANCHOR_DAY;
const NOW = new Date(ANCHOR.getTime() + 12 * 60 * 60 * 1000);
const TZ = "UTC";
const OWNER_ID = parityId("analytics", 1);
const EMPTY_ID = parityId("analytics", 2);

let owner: RouteAuth;
let empty: RouteAuth;

async function stored(userId: string) {
  const [healthScores, patterns] = await Promise.all([
    prisma.healthScoreRecord.findMany({
      where: { userId },
      orderBy: { dayKey: "asc" },
      select: {
        dayKey: true,
        timezone: true,
        composite: true,
        band: true,
        scoreVersion: true,
        composition: true,
        pillarScores: true,
        inputFingerprint: true,
        computedAt: true,
      },
    }),
    prisma.correlationPattern.findMany({
      where: { userId },
      orderBy: { canonicalKey: "asc" },
      select: {
        canonicalKey: true,
        family: true,
        factorKey: true,
        outcomeKey: true,
        lagDays: true,
        sampleSize: true,
        effectSize: true,
        pValue: true,
        qValue: true,
        evidenceHash: true,
        isCurrent: true,
        lastComputedAt: true,
      },
    }),
  ]);
  return { healthScores, patterns };
}

async function step(
  name: string,
  options: {
    auth?: RouteAuth;
    query?: Record<string, string>;
    userId?: string;
  } = {},
): Promise<void> {
  wideEventRecorder.take();
  effectRecorder.take();
  const res = await callRoute(GET, {
    method: "GET",
    route: "/api/analytics",
    query: options.query,
    auth: options.auth ?? owner,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  // Work the request left running (a rollup fill behind a read) finishes
  // before the next request, so each case starts from the same store.
  await settleBackgroundTasks();
  await expectParity(
    `analytics.${name}`,
    stable(
      relativeToAnchor(
        {
          status: res.status,
          cacheControl: res.headers.get("cache-control"),
          body: res.body,
          events: events.map(eventFacts).map(withoutRollupCoverage),
          effects: effectRecorder.take(),
          stored: await stored(options.userId ?? OWNER_ID),
        },
        ANCHOR,
      ),
      { since: NOW },
    ),
  );
}

/**
 * The blood-pressure fast path reports how many rollup rows it read. That
 * count follows the rollup tier's coverage at the moment of the request,
 * which background refills outside this route decide, so it differs between
 * two runs of the same code while the answer it fed does not. The answer
 * stays pinned in `body`; only the three diagnostic counts are dropped.
 */
function withoutRollupCoverage(facts: unknown): unknown {
  const meta = (facts as { meta?: { analytics?: { bp_in_target?: object } } })
    .meta;
  const bp = meta?.analytics?.bp_in_target as
    Record<string, unknown> | undefined;
  if (bp) {
    delete bp.row_count;
    delete bp.sys_rows;
    delete bp.dia_rows;
  }
  return facts;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const ownerRow = await makeUser({
    id: OWNER_ID,
    timezone: TZ,
    locale: "en",
    heightCm: 178,
    dateOfBirth: new Date("1975-04-02T00:00:00.000Z"),
    gender: "male",
  });
  await seedParityRecord({ userId: OWNER_ID, now: NOW, tz: TZ, tag: "an" });
  const rollups = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  await rollups.ensureUserRollupsFresh(OWNER_ID);
  await settleBackgroundTasks();
  owner = await makeSession(ownerRow);
  const emptyRow = await makeUser({ id: EMPTY_ID, timezone: "UTC" });
  empty = await makeSession(emptyRow);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("GET /api/analytics parity", () => {
  it("01 a slice outside the closed set", async () => {
    await step("01-invalid-slice", { query: { slice: "summary" } });
  });

  it("02 the summaries slice, cold", async () => {
    await step("02-summaries-cold", { query: { slice: "summaries" } });
  });

  it("03 the summaries slice, warm", async () => {
    await step("03-summaries-warm", { query: { slice: "summaries" } });
  });

  it("04 the default body, cold", async () => {
    await step("04-default-cold");
  });

  it("05 the default body, warm", async () => {
    await step("05-default-warm");
  });

  it("06 the summaries slice with modules off", async () => {
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: {
        modulePreferencesJson: {
          glucose: false,
          sleep: false,
          recovery: false,
        },
      },
    });
    await step("06-summaries-modules-off", { query: { slice: "summaries" } });
  });

  it("07 the default body in another language with a personal target", async () => {
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: {
        locale: "de",
        thresholdsJson: {
          BLOOD_PRESSURE_SYS: { min: 100, max: 125 },
          BLOOD_PRESSURE_DIA: { min: 60, max: 80 },
        },
      },
    });
    await step("07-default-de-personal-target");
  });

  it("08 an account with no profile and no data", async () => {
    await step("08-empty-account", { auth: empty, userId: EMPTY_ID });
  });

  it("09 an anonymous call", async () => {
    await step("09-anonymous", { auth: anonymous });
  });
});
