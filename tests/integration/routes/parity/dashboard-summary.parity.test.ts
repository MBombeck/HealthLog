/**
 * Parity for `GET /api/dashboard/summary` while its builder moves into
 * `src/lib/dashboard/`.
 *
 * One record carries every block the summary shapes (`record-fixture.ts`):
 * the walk reads it cold, warm, with modules off (gated after the cache),
 * in another language (served from the cache that still holds the first
 * greeting), for a delegate who may manage the record and one who may only
 * read it, without credentials, and for an account with no data. The
 * fire-and-forget rollup refresh is recorded instead of run.
 *
 * The clock is pinned to noon of a fixed day (`FIXED_ANCHOR_DAY`: the
 * chronotype reads work and free nights by weekday) and the snapshot is
 * written relative to the start of that day (`relativeToAnchor`). Every
 * window the summary cuts, in JS and in SQL, counts from the request's
 * clock, so the walk reads the same at any hour it runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/dashboard/summary/route";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";

import { anonymous, callRoute, type RouteAuth } from "../../../kit/call-route";
import { makeGrant, makeSession, makeUser } from "../../../kit/factories";
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

const prisma = getPrismaClient();
const ANCHOR = FIXED_ANCHOR_DAY;
const NOW = new Date(ANCHOR.getTime() + 12 * 60 * 60 * 1000);
const TZ = "UTC";
const OWNER_ID = parityId("dashsum", 1);
const EMPTY_ID = parityId("dashsum", 2);

let owner: RouteAuth;
let empty: RouteAuth;
let manager: RouteAuth & { sessionId: string };
let reader: RouteAuth & { sessionId: string };

async function step(
  name: string,
  auth: RouteAuth = owner,
  contract?: { skip: string },
): Promise<void> {
  wideEventRecorder.take();
  effectRecorder.take();
  const res = await callRoute(GET, {
    method: "GET",
    route: "/api/dashboard/summary",
    auth,
    ...(contract ? { contract } : {}),
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await settleBackgroundTasks();
  await expectParity(
    `dashboard-summary.${name}`,
    stable(
      relativeToAnchor(
        {
          status: res.status,
          body: res.body,
          events: events.map(eventFacts).map(withSortedMeta),
          effects: effectRecorder.take(),
        },
        ANCHOR,
      ),
      { since: NOW },
    ),
  );
}

/**
 * The builder's sub-reads run concurrently and each annotates its own timing
 * when it settles, so the meta keys arrive in a different order on each run.
 * The values are the same; the keys are sorted.
 */
function withSortedMeta(facts: unknown): unknown {
  const f = facts as { meta?: Record<string, unknown> };
  if (!f.meta) return facts;
  return {
    ...f,
    meta: Object.fromEntries(
      Object.entries(f.meta).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
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
  await seedParityRecord({ userId: OWNER_ID, now: NOW, tz: TZ, tag: "ds" });
  const rollups = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  await rollups.ensureUserRollupsFresh(OWNER_ID);
  await settleBackgroundTasks();
  owner = await makeSession(ownerRow);
  const emptyRow = await makeUser({
    id: EMPTY_ID,
    username: "empty-account",
    timezone: "UTC",
  });
  empty = await makeSession(emptyRow);
  const managerRow = await makeUser({ timezone: "UTC", locale: "de" });
  await makeGrant(ownerRow, managerRow, { access: "MANAGE" });
  manager = await makeSession(managerRow);
  const readerRow = await makeUser({ timezone: "UTC" });
  await makeGrant(ownerRow, readerRow);
  reader = await makeSession(readerRow);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("GET /api/dashboard/summary parity", () => {
  it("01 cold, then warm", async () => {
    await step("01-cold");
    await step("02-warm");
  });

  it("03 modules off, gated after the cache", async () => {
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: {
        modulePreferencesJson: { glucose: false, sleep: false, mood: false },
      },
    });
    try {
      await step("03-modules-off");
    } finally {
      // Restored even when the case fails, so the cases after it are not
      // read with the modules still off.
      await prisma.user.update({
        where: { id: OWNER_ID },
        data: { modulePreferencesJson: {} },
      });
    }
  });

  it("04 another language, served from the cache", async () => {
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: { locale: "de" },
    });
    await step("04-de-cached");
  });

  it("05 a delegate who may manage, and one who may only read", async () => {
    await switchSessionTo(manager.sessionId, OWNER_ID);
    await step("05-manager", manager);
    await switchSessionTo(manager.sessionId, null);
    await switchSessionTo(reader.sessionId, OWNER_ID);
    await step("06-reader", reader);
    await switchSessionTo(reader.sessionId, null);
  });

  it("07 no credentials, and an account with no data", async () => {
    await step("07-anonymous", anonymous);
    await step("08-empty-account", empty);
  });
});
