/**
 * Parity for `POST /api/import/csv` while its batched writer moves into
 * `src/lib/import/`.
 *
 * A dry run of a mixed file (rows with and without an external id, a key
 * repeated inside the file, a natural-key twin, a row the parser refuses),
 * the same file for real, the same file again, a changed file that moves a
 * reading to another day and re-imports a deleted row, and the refusals (an
 * unknown parameter, a file without a usable header). After each request
 * the snapshot holds the response, the wide event, the recorded arrival and
 * refresh tails, and the stored measurements, rollups and audit rows. The
 * shared import bucket is emptied before each request so the walk never
 * meets its own rate limit.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/import/csv/route";

import { callRoute, type RouteAuth } from "../../../kit/call-route";
import { makeSession, makeUser } from "../../../kit/factories";
import {
  effectRecorder,
  eventFacts,
  expectParity,
  stable,
  wideEventRecorder,
} from "../../../kit/parity";
import { getPrismaClient, truncateAllTables } from "../../setup";

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
vi.mock("@/lib/arrivals/emit-shared", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/arrivals/emit-shared")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    emitDataArrival: async (...args: unknown[]) => {
      effectRecorder.record("emitDataArrival", args);
    },
  };
});
vi.mock("@/lib/daily/morning-refresh-trigger", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/daily/morning-refresh-trigger")
    >();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    maybeEnqueueMorningRefresh: async (...args: unknown[]) => {
      effectRecorder.record("maybeEnqueueMorningRefresh", args);
    },
  };
});
vi.mock("@/lib/jobs/pr-detection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/pr-detection")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    enqueuePrDetection: async (...args: unknown[]) => {
      effectRecorder.record("enqueuePrDetection", args);
    },
  };
});

vi.mock("@/lib/insights/status-invalidation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/status-invalidation")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    // Detached from the request but inside its context: run for real, its
    // annotate can land on the request's wide event or miss it, depending on
    // timing. Recorded instead, like the other tails.
    invalidateStatusInsightsForTypes: async (...args: unknown[]) => {
      effectRecorder.record("invalidateStatusInsightsForTypes", args);
    },
  };
});

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const HEADER = "type,value,unit,measuredAt,glucoseContext,notes,externalId";

let userId: string;
let owner: RouteAuth;

async function stored() {
  const [measurements, rollups, audit] = await Promise.all([
    prisma.measurement.findMany({
      where: { userId },
      orderBy: [{ type: "asc" }, { measuredAt: "asc" }, { value: "asc" }],
      select: {
        type: true,
        value: true,
        unit: true,
        source: true,
        externalId: true,
        measuredAt: true,
        notes: true,
        notesEncrypted: true,
        glucoseContext: true,
        deletedAt: true,
      },
    }),
    prisma.measurementRollup.findMany({
      where: { userId, granularity: "DAY" },
      orderBy: [{ type: "asc" }, { bucketStart: "asc" }],
      select: { type: true, bucketStart: true, count: true, mean: true },
    }),
    prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { action: true, details: true },
    }),
  ]);
  return { measurements, rollups, audit };
}

async function step(
  name: string,
  lines: string[],
  query: Record<string, string> = {},
): Promise<void> {
  await prisma.rateLimit.deleteMany({ where: { key: `import:${userId}` } });
  wideEventRecorder.take();
  effectRecorder.take();
  const res = await callRoute(POST, {
    method: "POST",
    route: "/api/import/csv",
    query,
    text: lines.join("\n"),
    headers: { "content-type": "text/csv" },
    auth: owner,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await expectParity(
    `import-csv.${name}`,
    stable(
      {
        status: res.status,
        body: res.body,
        events: events.map(eventFacts),
        effects: effectRecorder.take(),
        stored: await stored(),
      },
      { since: NOW },
    ),
  );
}

const FILE = [
  HEADER,
  "WEIGHT,81.4,kg,2026-10-10T06:30:00.000Z,,after the run,exp-w-1",
  "WEIGHT,81.9,kg,2026-10-11T06:30:00.000Z,,,exp-w-2",
  // The same key again later in the file: the last value wins.
  "WEIGHT,82.0,kg,2026-10-11T06:30:00.000Z,,,exp-w-2",
  "BLOOD_GLUCOSE,104,mg/dL,2026-10-11T08:00:00.000Z,FASTING,,",
  // A natural-key twin of the line above.
  "BLOOD_GLUCOSE,104,mg/dL,2026-10-11T08:00:00.000Z,FASTING,,",
  "SLEEP_DURATION,412,minutes,2026-10-12T06:00:00.000Z,,,exp-s-1",
  "PULSE,64,bpm,2026-10-12T07:00:00.000Z,,,",
  // Refused by the parser.
  "WEIGHT,not-a-number,kg,2026-10-12T06:30:00.000Z,,,",
];

const CHANGED = [
  HEADER,
  // Unchanged.
  "WEIGHT,81.4,kg,2026-10-10T06:30:00.000Z,,after the run,exp-w-1",
  // Moved to another day.
  "WEIGHT,82.0,kg,2026-10-09T06:30:00.000Z,,,exp-w-2",
  // Deleted since the last import; re-importing brings it back.
  "SLEEP_DURATION,430,minutes,2026-10-12T06:00:00.000Z,,,exp-s-1",
  "PULSE,66,bpm,2026-10-13T07:00:00.000Z,,,",
];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "Europe/Berlin" });
  userId = user.id;
  owner = await makeSession(user);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("POST /api/import/csv parity", () => {
  it("01 a dry run", async () => {
    await step("01-dry-run", FILE, { dryRun: "1" });
  });

  it("02 the file for real, then again", async () => {
    await step("02-first-import", FILE);
    await step("03-same-file", FILE);
  });

  it("04 a changed file over a deleted row", async () => {
    await prisma.measurement.updateMany({
      where: { userId, externalId: "exp-s-1" },
      data: { deletedAt: new Date("2026-10-13T08:00:00.000Z") },
    });
    await step("04-changed-file", CHANGED);
  });

  it("05 the refusals", async () => {
    await step("05-unknown-parameter", FILE, { dryrun: "1" });
    await step("06-no-header", ["just,some,words"]);
  });
});
