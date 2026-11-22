/**
 * Parity for the reads an app launch sends together, while the summaries
 * slice they share changes how it reads: `GET /api/dashboard/snapshot`,
 * `GET /api/daily/digest`, `GET /api/analytics?slice=summaries` and
 * `GET /api/insights/targets`.
 *
 * The record is the shared parity record (`record-fixture.ts`) plus the
 * parts of a long history the slice composes in separate passes: readings
 * older than the rollup fold window (the pre-fold remainder) from two
 * sources on the same days, an hourly-mean type (pulse) with several
 * readings in an hour, sleep nights years back, and the year-ago window of
 * `avg30LastYear`. Each read runs cold (every process cache dropped) and
 * warm; the digest and the targets also run after the snapshot filled the
 * slice, the order a launch sends them in.
 *
 * The clock is pinned (`Date` only) to noon of a fixed day; see `NOW`. The
 * fire-and-forget rollup refresh is recorded instead of run. Only the status
 * and the body are kept: the sub-read timings in the wide event differ on
 * every run.
 */
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { GET as analyticsGet } from "@/app/api/analytics/route";
import { GET as digestGet } from "@/app/api/daily/digest/route";
import { GET as snapshotGet } from "@/app/api/dashboard/snapshot/route";
import { GET as targetsGet } from "@/app/api/insights/targets/route";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";

import { callRoute, type RouteAuth } from "../../../kit/call-route";
import { makeSession, makeUser } from "../../../kit/factories";
import {
  expectParity,
  FIXED_ANCHOR_DAY,
  relativeToAnchor,
  stable,
} from "../../../kit/parity";
import { getPrismaClient, truncateAllTables } from "../../setup";
import { parityId, seedParityRecord } from "./record-fixture";

vi.mock("@/lib/rollups/measurement-rollups", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rollups/measurement-rollups")>();
  return {
    ...actual,
    ensureUserRollupsFresh: async () => {},
  };
});

const prisma = getPrismaClient();
const ANCHOR = FIXED_ANCHOR_DAY;
const NOW = new Date(ANCHOR.getTime() + 12 * 60 * 60 * 1000);
const TZ = "Europe/Berlin";
const OWNER_ID = parityId("launch", 1);
const DAY_MS = 86_400_000;

let owner: RouteAuth;

type Handler = Parameters<typeof callRoute>[0];

async function step(
  name: string,
  handler: Handler,
  route: string,
  search?: Record<string, string>,
): Promise<void> {
  const res = await callRoute(handler, {
    method: "GET",
    route,
    auth: owner,
    ...(search ? { query: search } : {}),
  });
  await settleBackgroundTasks();
  await expectParity(
    `launch-reads.${name}`,
    stable(relativeToAnchor({ status: res.status, body: res.body }, ANCHOR), {
      since: NOW,
    }),
  );
}

/** The UTC instant `hh:mm` on the day `d` days before `NOW`. */
function at(d: number, hh: number, mm = 0): Date {
  const base = new Date(NOW.getTime() - d * DAY_MS);
  base.setUTCHours(hh, mm, 0, 0);
  return base;
}

/**
 * The long-history rows: everything older than five years lies outside the
 * fold window and reaches the slice through the pre-fold remainder.
 */
async function seedLongHistory(): Promise<void> {
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  const push = (
    type: Prisma.MeasurementCreateManyInput["type"],
    source: Prisma.MeasurementCreateManyInput["source"],
    measuredAt: Date,
    value: number,
    unit: string,
    extra: Partial<Prisma.MeasurementCreateManyInput> = {},
  ) =>
    rows.push({
      userId: OWNER_ID,
      type,
      source,
      measuredAt,
      value,
      unit,
      ...extra,
    });
  // Six to seven years back: weight from two sources on the same days (the
  // ladder keeps one per day), pulse in dense hours from two sources, and
  // staged sleep nights.
  for (let d = 5 * 365 + 20; d < 7 * 365; d += 3) {
    push("WEIGHT", "WITHINGS", at(d, 6, 30), 84 + (d % 17) / 10, "kg");
    if (d % 2 === 0) {
      push("WEIGHT", "MANUAL", at(d, 7, 0), 85.5 + (d % 11) / 10, "kg");
    }
    for (let i = 0; i < 4; i++) {
      push(
        "PULSE",
        "APPLE_HEALTH",
        at(d, 9, i * 7),
        60 + ((d + i) % 23),
        "bpm",
      );
    }
    push("PULSE", "WITHINGS", at(d, 9, 40), 71 + (d % 5), "bpm");
    push("PULSE", "APPLE_HEALTH", at(d, 15, 5), 77 + (d % 9), "bpm");
    if (d % 6 === 0) {
      push("SLEEP_DURATION", "APPLE_HEALTH", at(d, 1), 180 + (d % 40), "min", {
        sleepStage: "CORE",
      });
      push("SLEEP_DURATION", "APPLE_HEALTH", at(d, 4), 70 + (d % 20), "min", {
        sleepStage: "DEEP",
      });
      push("SLEEP_DURATION", "APPLE_HEALTH", at(d, 5), 55 + (d % 15), "min", {
        sleepStage: "REM",
      });
    }
  }
  // The year-ago window of `avg30LastYear` (395 to 365 days back), and pulse
  // inside the fold window so the hourly-mean latest-day pass has a day.
  for (let d = 360; d <= 400; d++) {
    push("WEIGHT", "WITHINGS", at(d, 6, 45), 82 + (d % 13) / 10, "kg");
    push("BLOOD_PRESSURE_SYS", "WITHINGS", at(d, 7, 0), 128 + (d % 9), "mmHg");
  }
  for (let d = 0; d < 40; d++) {
    for (let h = 6; h < 22; h += 4) {
      push("PULSE", "APPLE_HEALTH", at(d, h, 10), 58 + ((d + h) % 30), "bpm");
      push("PULSE", "APPLE_HEALTH", at(d, h, 25), 61 + ((d * h) % 27), "bpm");
    }
  }
  await prisma.measurement.createMany({ data: rows });
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const ownerRow = await makeUser({
    id: OWNER_ID,
    timezone: TZ,
    locale: "en",
    displayName: "Sam",
    heightCm: 178,
    dateOfBirth: new Date("1975-04-02T00:00:00.000Z"),
    gender: "male",
  });
  await seedParityRecord({ userId: OWNER_ID, now: NOW, tz: TZ, tag: "lr" });
  await seedLongHistory();
  const rollups = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  await rollups.recomputeUserRollups(OWNER_ID, {
    granularities: rollups.ALL_GRANULARITIES,
  });
  await settleBackgroundTasks();
  owner = await makeSession(ownerRow);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("launch reads parity", { shuffle: false }, () => {
  it("01 the snapshot cold, then warm", async () => {
    __resetAllCachesForTests();
    await step("01-snapshot-cold", snapshotGet, "/api/dashboard/snapshot");
    await step("02-snapshot-warm", snapshotGet, "/api/dashboard/snapshot");
  });

  it("03 the digest after the snapshot, then cold", async () => {
    await step("03-digest-after-snapshot", digestGet, "/api/daily/digest");
    __resetAllCachesForTests();
    await step("04-digest-cold", digestGet, "/api/daily/digest");
  });

  it("05 the summaries slice cold, then warm", async () => {
    __resetAllCachesForTests();
    const search = { slice: "summaries" };
    await step("05-summaries-cold", analyticsGet, "/api/analytics", search);
    await step("06-summaries-warm", analyticsGet, "/api/analytics", search);
  });

  it("07 the targets cold, then after the snapshot", async () => {
    __resetAllCachesForTests();
    await step("07-targets-cold", targetsGet, "/api/insights/targets");
    __resetAllCachesForTests();
    await step(
      "08-snapshot-before-targets",
      snapshotGet,
      "/api/dashboard/snapshot",
    );
    await step(
      "09-targets-after-snapshot",
      targetsGet,
      "/api/insights/targets",
    );
  });
});
