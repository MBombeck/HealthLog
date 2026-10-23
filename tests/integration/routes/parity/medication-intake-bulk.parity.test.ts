/**
 * Parity for `POST /api/medications/intake/bulk` while the batch ingest moves
 * into `src/lib/medications/`.
 *
 * One record walks through the cases the route tells apart, in order, each
 * request seeing what the earlier ones stored. A first mixed batch carries
 * one entry per per-entry outcome: an unknown medication, a record-only one,
 * an unstable idempotency key and an unstable external id, a take inside its
 * band, a pinned take and both pin refusals, a skip on a named slot, a
 * pending echo onto a recorded dose and one onto a fresh slot, a standalone
 * take with a site, a dose override and a key, its replay, a disallowed
 * site, an Apple dose and its repeat inside the batch, an Apple dose whose
 * slot another dose holds, and a skip that converges onto the standalone
 * dose. Then the same batch again, a background and a backfill sync, the
 * refusals (too large, a body the schema refuses, an Apple entry on a native
 * medication), a native client, a narrow token, a delegate and nobody.
 *
 * After each request the snapshot holds the response, the wide event, the
 * recorded tails, every medication row of the accounts, and the sync
 * checkpoint and Apple Health arrival rows the batch writes. The clock is
 * pinned (`Date` only), so the snapshot is the same on every day it runs.
 */
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { POST } from "@/app/api/medications/intake/bulk/route";

import { anonymous, type RouteAuth } from "../../../kit/call-route";
import {
  makeMedication,
  makeSession,
  makeToken,
  makeUser,
} from "../../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../../setup";
import { delegateOf, parityStep } from "./medication-state";

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

// The tails the route starts without awaiting them (the cross-device push,
// the web-push dose clear with its badge count), recorded instead of run
// (see `effectRecorder`).
vi.mock(
  "@/lib/notifications/medication-intake-sync",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/notifications/medication-intake-sync")
      >();
    const { effectRecorder } = await import("../../../kit/parity");
    return {
      ...actual,
      queueMedicationIntakeSync: (...args: unknown[]) => {
        effectRecorder.record("queueMedicationIntakeSync", args);
      },
    };
  },
);
vi.mock("@/lib/notifications/web-push-clear", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/notifications/web-push-clear")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    dispatchMedicationIntakeWebClearBulk: async (...args: unknown[]) => {
      effectRecorder.record("dispatchMedicationIntakeWebClearBulk", args);
    },
  };
});
vi.mock("@/lib/medications/outstanding-doses", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/medications/outstanding-doses")
    >();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    countOutstandingDosesToday: async (...args: unknown[]) => {
      effectRecorder.record("countOutstandingDosesToday", args);
      return 2;
    },
  };
});

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const ROUTE = "/api/medications/intake/bulk";

let ownerId: string;
let userIds: string[];
let owner: RouteAuth;
let ownerBearer: RouteAuth;
let narrowBearer: RouteAuth;
let writer: { auth: RouteAuth; headers: Record<string, string> };
const med: Record<string, string> = {};

type Caller = { auth?: RouteAuth; headers?: Record<string, string> };

/** The sync checkpoint and the Apple Health arrival rows of the owner. */
async function syncState() {
  const [user, arrivals] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { lastSyncedAt: true },
    }),
    prisma.healthKitTypeSync.findMany({
      where: { userId: ownerId },
      orderBy: { type: "asc" },
      select: {
        type: true,
        lastReceivedAt: true,
        lastTrigger: true,
        lastNewSampleAt: true,
        lastBackgroundAt: true,
        lastSeenDuplicateAt: true,
      },
    }),
  ]);
  return { lastSyncedAt: user.lastSyncedAt, arrivals };
}

/**
 * An audit row a refusal writes without awaiting it: the narrow token's
 * `auth.bearer.failure`. (An owner's own schema refusal files none.)
 */
async function auditRows(action: string, count: number): Promise<void> {
  // Polled on the real timer: the pinned clock stamps the rows read back,
  // and nothing here may move it.
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const rows = await prisma.auditLog.count({ where: { action } });
    if (rows >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fewer than ${count} ${action} rows landed`);
}

async function post(
  name: string,
  body: unknown,
  options: Caller & { settle?: () => Promise<void> } = {},
) {
  await parityStep({
    name: `medication-intake-bulk.${name}`,
    handler: POST,
    options: {
      method: "POST",
      route: ROUTE,
      body,
      auth: options.auth ?? owner,
      headers: options.headers,
    },
    userIds,
    now: NOW,
    settle: options.settle,
    extra: syncState,
  });
}

async function intake(
  medicationId: string,
  data: {
    scheduledFor: string;
    takenAt?: string;
    source?: "REMINDER" | "APPLE_HEALTH";
    externalId?: string;
  },
) {
  await prisma.medicationIntakeEvent.create({
    data: {
      userId: ownerId,
      medicationId,
      scheduledFor: new Date(data.scheduledFor),
      takenAt: data.takenAt ? new Date(data.takenAt) : null,
      source: data.source ?? "REMINDER",
      externalId: data.externalId ?? null,
      createdAt: new Date("2026-10-01T06:00:00.000Z"),
    },
  });
}

const daily = (time: string, windowEnd: string) => ({
  windowStart: time,
  windowEnd,
  timesOfDay: [time],
  rrule: "FREQ=DAILY",
});

/** One entry per per-entry outcome the loop tells apart. */
function mixedBatch() {
  return {
    syncTrigger: "foreground",
    entries: [
      { medicationId: med.foreign, takenAt: "2026-10-15T08:10:00.000Z" },
      { medicationId: med.recordOnly, takenAt: "2026-10-15T07:10:00.000Z" },
      {
        medicationId: med.daily,
        takenAt: "2026-10-15T08:20:00.000Z",
        idempotencyKey: "<HKDoseEvent: 0x600003a1c0c0>",
      },
      { medicationId: med.daily, takenAt: "2026-10-15T08:30:00.000Z" },
      {
        medicationId: med.daily,
        takenAt: "2026-10-13T11:00:00.000Z",
        forceSlotInstant: "2026-10-13T08:00:00.000Z",
      },
      {
        medicationId: med.daily,
        takenAt: "2026-10-13T16:00:00.000Z",
        forceSlotInstant: "2026-10-13T15:00:00.000Z",
      },
      {
        medicationId: med.daily,
        takenAt: "2026-10-14T23:00:00.000Z",
        forceSlotInstant: "2026-10-14T20:00:00.000Z",
      },
      {
        medicationId: med.daily,
        skipped: true,
        scheduledFor: "2026-10-15T20:00:00.000Z",
      },
      { medicationId: med.daily, scheduledFor: "2026-10-14T20:00:00.000Z" },
      { medicationId: med.daily, scheduledFor: "2026-10-16T08:00:00.000Z" },
      {
        medicationId: med.pen,
        takenAt: "2026-10-15T10:00:00.000Z",
        injectionSite: "ABDOMEN_LEFT",
        doseTaken: "0.5 pen",
        idempotencyKey: "bulk-key-0001",
      },
      {
        medicationId: med.pen,
        takenAt: "2026-10-15T10:00:00.000Z",
        idempotencyKey: "bulk-key-0001",
      },
      {
        medicationId: med.pen,
        takenAt: "2026-10-15T10:30:00.000Z",
        injectionSite: "ABDOMEN_RIGHT",
      },
      {
        medicationId: med.apple,
        takenAt: "2026-10-15T09:20:00.000Z",
        source: "APPLE_HEALTH",
        externalId: "hk-dose-0001",
      },
      {
        medicationId: med.apple,
        takenAt: "2026-10-15T09:20:00.000Z",
        source: "APPLE_HEALTH",
        externalId: "hk-dose-0001",
      },
      {
        medicationId: med.apple,
        takenAt: "2026-10-14T09:30:00.000Z",
        source: "APPLE_HEALTH",
        externalId: "hk-dose-0002",
      },
      {
        medicationId: med.apple,
        takenAt: "2026-10-14T10:00:00.000Z",
        source: "APPLE_HEALTH",
        externalId: "<HKMedicationDoseEvent: 0x600003b2d0d0>",
      },
      {
        medicationId: med.pen,
        skipped: true,
        scheduledFor: "2026-10-15T10:00:00.000Z",
      },
    ],
  };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({
    timezone: "UTC",
    globalExcludedInjectionSites: ["ABDOMEN_RIGHT"],
  });
  ownerId = user.id;
  owner = await makeSession(user);
  ownerBearer = await makeToken(user, { name: "kit-phone" });
  narrowBearer = await makeToken(user, {
    name: "kit-ingest",
    permissions: ["medication:ingest"],
  });
  const created = new Date("2026-10-01T06:00:00.000Z");

  const dailyMed = await makeMedication(
    user,
    {
      name: "Twice daily",
      startsOn: new Date("2026-10-01"),
      createdAt: created,
      snoozedUntil: new Date("2026-10-15T12:30:00.000Z"),
    },
    [daily("08:00", "10:00"), daily("20:00", "22:00")],
  );
  med.daily = dailyMed.id;
  await prisma.medicationInventoryItem.create({
    data: {
      userId: ownerId,
      medicationId: dailyMed.id,
      unitsTotal: 30,
      unitsRemaining: 30,
      purchasedAt: created,
    },
  });
  await intake(dailyMed.id, { scheduledFor: "2026-10-15T08:00:00.000Z" });
  await intake(dailyMed.id, {
    scheduledFor: "2026-10-14T20:00:00.000Z",
    takenAt: "2026-10-14T20:05:00.000Z",
  });

  med.pen = (
    await makeMedication(
      user,
      {
        name: "As-needed pen",
        createdAt: created,
        asNeeded: true,
        deliveryForm: "INJECTION",
        trackInjectionSites: true,
        allowedInjectionSites: ["ABDOMEN_LEFT", "ABDOMEN_RIGHT"],
      },
      [],
    )
  ).id;

  const apple = await makeMedication(
    user,
    {
      name: "Apple mirror",
      startsOn: new Date("2026-10-01"),
      createdAt: created,
      externalSource: "APPLE_HEALTH",
      externalId: "hk-concept-0001",
    },
    [daily("09:00", "11:00")],
  );
  med.apple = apple.id;
  await intake(apple.id, {
    scheduledFor: "2026-10-14T09:00:00.000Z",
    takenAt: "2026-10-14T09:05:00.000Z",
    source: "APPLE_HEALTH",
    externalId: "hk-dose-0000",
  });

  med.recordOnly = (
    await makeMedication(
      user,
      { name: "Record only", createdAt: created, trackIntake: false },
      [daily("07:00", "08:00")],
    )
  ).id;

  const stranger = await makeUser({ timezone: "UTC" });
  med.foreign = (await makeMedication(stranger, { name: "Not yours" })).id;

  const w = await delegateOf(prisma, user, "WRITE");
  writer = { auth: w.auth, headers: w.headers };
  userIds = [ownerId, w.delegate.id];
});

afterAll(() => {
  vi.useRealTimers();
});

describe("POST /api/medications/intake/bulk parity", () => {
  it("01 a mixed first batch", async () => {
    await post("01-mixed", mixedBatch());
  });

  it("02 the same batch again", async () => {
    await post("02-mixed-again", mixedBatch());
  });

  it("03 a background sync and a backfill", async () => {
    await post("03a-background", {
      syncTrigger: "background",
      entries: [
        {
          medicationId: med.apple,
          takenAt: "2026-10-13T09:10:00.000Z",
          source: "APPLE_HEALTH",
          externalId: "hk-dose-0003",
        },
      ],
    });
    await post("03b-backfill", {
      syncTrigger: "backfill",
      entries: [
        {
          medicationId: med.apple,
          takenAt: "2026-10-12T09:10:00.000Z",
          source: "APPLE_HEALTH",
          externalId: "hk-dose-0004",
        },
      ],
    });
  });

  it("04 the batch refusals", async () => {
    await post("04a-too-large", {
      entries: Array.from({ length: 501 }, () => ({
        medicationId: med.daily,
      })),
    });
    await post("04b-invalid", {
      entries: [{ medicationId: "", takenAt: "never" }],
    });
    await post("04c-apple-not-mirrored", {
      entries: [
        {
          medicationId: med.daily,
          takenAt: "2026-10-12T08:10:00.000Z",
          source: "APPLE_HEALTH",
          externalId: "hk-dose-0005",
        },
      ],
    });
  });

  it("05 a native client, a narrow token, a delegate and nobody", async () => {
    const batch = {
      entries: [
        { medicationId: med.daily, takenAt: "2026-10-12T08:10:00.000Z" },
      ],
    };
    await post("05a-native", batch, { auth: ownerBearer });
    await post("05b-narrow-token", batch, {
      auth: narrowBearer,
      settle: () => auditRows("auth.bearer.failure", 1),
    });
    await post("05c-delegate", batch, writer);
    await post("05d-anonymous", batch, { auth: anonymous });
  });
});
