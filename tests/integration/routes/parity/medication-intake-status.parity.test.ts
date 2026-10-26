/**
 * Parity for `GET` and `POST /api/medications/intake` while the today list,
 * the compliance buckets and the status update move into
 * `src/lib/medications/`.
 *
 * One record walks through the cases the route tells apart, in order, each
 * request seeing what the earlier ones stored. The reads: today's list (with
 * the projection it runs, and every status a row can read as), the
 * compliance buckets cold and from the cache, a query the schema refuses, a
 * reading delegate and nobody. The updates: a take in place, a take that
 * re-binds to another slot (tombstone and converge, the recorded site
 * carried), a pinned take and a pin that is no slot, a skip over a recorded
 * dose, a snooze with and without its end, the not-found answers (an unknown
 * event, another account's, a tombstoned one), the record-only rule both
 * ways, the injection-site refusal and an allowed site, a body the schema
 * refuses, and a delegate who marks an open dose, is refused a snooze and a
 * correction, a reader and nobody.
 *
 * After each request the snapshot holds the response, the wide event, the
 * recorded tails and every medication row of the accounts. The clock is
 * pinned (`Date` only), so the snapshot is the same on every day it runs.
 */
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { GET, POST } from "@/app/api/medications/intake/route";

import { anonymous, type RouteAuth } from "../../../kit/call-route";
import { makeMedication, makeSession, makeUser } from "../../../kit/factories";
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
// the web-push dose clear with its badge count, the owner's notification of a
// delegated dose), recorded instead of run (see `effectRecorder`).
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
    dispatchMedicationIntakeWebClear: async (...args: unknown[]) => {
      effectRecorder.record("dispatchMedicationIntakeWebClear", args);
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
vi.mock("@/lib/notifications/delegated-intake", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/notifications/delegated-intake")
    >();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    notifyDelegatedIntake: async (...args: unknown[]) => {
      effectRecorder.record("notifyDelegatedIntake", args);
    },
  };
});

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const ROUTE = "/api/medications/intake";

let ownerId: string;
let userIds: string[];
let owner: RouteAuth;
let writer: { auth: RouteAuth; headers: Record<string, string> };
let reader: { auth: RouteAuth; headers: Record<string, string> };
const ev: Record<string, string> = {};

type Caller = { auth?: RouteAuth; headers?: Record<string, string> };

async function get(
  name: string,
  query: Record<string, string>,
  caller: Caller = {},
) {
  await parityStep({
    name: `medication-intake-status.${name}`,
    handler: GET,
    options: {
      method: "GET",
      route: ROUTE,
      query,
      auth: caller.auth ?? owner,
      headers: caller.headers,
    },
    userIds,
    now: NOW,
  });
}

async function post(name: string, body: unknown, caller: Caller = {}) {
  await parityStep({
    name: `medication-intake-status.${name}`,
    handler: POST,
    options: {
      method: "POST",
      route: ROUTE,
      body,
      auth: caller.auth ?? owner,
      headers: caller.headers,
    },
    userIds,
    now: NOW,
  });
}

async function intake(
  key: string,
  medicationId: string,
  data: {
    scheduledFor: string;
    takenAt?: string;
    skipped?: boolean;
    autoMissed?: boolean;
    deletedAt?: string;
    injectionSite?: "ABDOMEN_LEFT";
    userId?: string;
  },
) {
  const row = await prisma.medicationIntakeEvent.create({
    data: {
      userId: data.userId ?? ownerId,
      medicationId,
      scheduledFor: new Date(data.scheduledFor),
      takenAt: data.takenAt ? new Date(data.takenAt) : null,
      skipped: data.skipped ?? false,
      autoMissed: data.autoMissed ?? false,
      deletedAt: data.deletedAt ? new Date(data.deletedAt) : null,
      injectionSite: data.injectionSite ?? null,
      source: "REMINDER",
      createdAt: new Date("2026-10-01T06:00:00.000Z"),
    },
  });
  ev[key] = row.id;
}

const daily = (time: string, windowEnd: string) => ({
  windowStart: time,
  windowEnd,
  timesOfDay: [time],
  rrule: "FREQ=DAILY",
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "UTC" });
  ownerId = user.id;
  owner = await makeSession(user);
  const created = new Date("2026-10-01T06:00:00.000Z");

  const twice = await makeMedication(
    user,
    {
      name: "Twice daily",
      startsOn: new Date("2026-10-01"),
      createdAt: created,
      snoozedUntil: new Date("2026-10-15T12:30:00.000Z"),
      deliveryForm: "INJECTION",
      trackInjectionSites: true,
      allowedInjectionSites: ["ABDOMEN_LEFT"],
    },
    [daily("08:00", "10:00"), daily("20:00", "22:00")],
  );
  await prisma.medicationInventoryItem.create({
    data: {
      userId: ownerId,
      medicationId: twice.id,
      unitsTotal: 30,
      unitsRemaining: 30,
      purchasedAt: created,
    },
  });
  await intake("todayMorning", twice.id, {
    scheduledFor: "2026-10-15T08:00:00.000Z",
  });
  await intake("todayEvening", twice.id, {
    scheduledFor: "2026-10-15T20:00:00.000Z",
  });
  await intake("moveMe", twice.id, {
    scheduledFor: "2026-10-14T08:00:00.000Z",
    injectionSite: "ABDOMEN_LEFT",
  });
  await intake("pinMe", twice.id, {
    scheduledFor: "2026-10-13T20:00:00.000Z",
  });
  await intake("skipMe", twice.id, {
    scheduledFor: "2026-10-12T08:00:00.000Z",
    takenAt: "2026-10-12T08:10:00.000Z",
  });
  await intake("snoozeMe", twice.id, {
    scheduledFor: "2026-10-11T08:00:00.000Z",
  });
  await intake("resolved", twice.id, {
    scheduledFor: "2026-10-10T08:00:00.000Z",
    takenAt: "2026-10-10T08:05:00.000Z",
  });
  await intake("tombstoned", twice.id, {
    scheduledFor: "2026-10-09T08:00:00.000Z",
    deletedAt: "2026-10-09T09:00:00.000Z",
  });

  const pen = await makeMedication(
    user,
    {
      name: "Daily pen",
      startsOn: new Date("2026-10-01"),
      createdAt: created,
      deliveryForm: "INJECTION",
      trackInjectionSites: true,
      allowedInjectionSites: ["ABDOMEN_LEFT", "ABDOMEN_RIGHT"],
    },
    [daily("09:00", "11:00")],
  );
  await intake("penToday", pen.id, {
    scheduledFor: "2026-10-15T09:00:00.000Z",
  });
  await prisma.user.update({
    where: { id: ownerId },
    data: { globalExcludedInjectionSites: ["ABDOMEN_RIGHT"] },
  });

  const mixed = await makeMedication(
    user,
    {
      name: "Three times",
      startsOn: new Date("2026-10-01"),
      createdAt: created,
    },
    [daily("06:00", "07:00"), daily("10:00", "11:00"), daily("13:00", "14:00")],
  );
  await intake("missed", mixed.id, {
    scheduledFor: "2026-10-15T06:00:00.000Z",
    autoMissed: true,
  });
  await intake("taken", mixed.id, {
    scheduledFor: "2026-10-15T10:00:00.000Z",
    takenAt: "2026-10-15T10:05:00.000Z",
  });
  await intake("skipped", mixed.id, {
    scheduledFor: "2026-10-15T13:00:00.000Z",
    skipped: true,
  });

  const recordOnly = await makeMedication(
    user,
    { name: "Record only", createdAt: created, trackIntake: false },
    [daily("07:00", "08:00")],
  );
  await intake("recordOpen", recordOnly.id, {
    scheduledFor: "2026-10-14T07:00:00.000Z",
  });
  await intake("recordTaken", recordOnly.id, {
    scheduledFor: "2026-10-13T07:00:00.000Z",
    takenAt: "2026-10-13T07:05:00.000Z",
  });

  const stranger = await makeUser({ timezone: "UTC" });
  const foreign = await makeMedication(stranger, { name: "Not yours" });
  await intake("foreign", foreign.id, {
    scheduledFor: "2026-10-15T08:00:00.000Z",
    userId: stranger.id,
  });

  const w = await delegateOf(prisma, user, "WRITE");
  const r = await delegateOf(prisma, user, "READ");
  writer = { auth: w.auth, headers: w.headers };
  reader = { auth: r.auth, headers: r.headers };
  userIds = [ownerId, w.delegate.id, r.delegate.id];
});

afterAll(() => {
  vi.useRealTimers();
});

describe("GET /api/medications/intake parity", () => {
  it("01 today's list", async () => {
    await get("01-today", { scope: "today" });
  });

  it("02 the compliance buckets, cold and from the cache", async () => {
    await get("02a-compliance-cold", { scope: "compliance", days: "7" });
    await get("02b-compliance-warm", { scope: "compliance", days: "7" });
  });

  it("03 a query the schema refuses", async () => {
    await get("03-invalid", { scope: "yesterday", days: "0" });
  });

  it("04 a reading delegate, and nobody", async () => {
    await get("04a-reader", { scope: "today" }, reader);
    await get("04b-anonymous", { scope: "today" }, { auth: anonymous });
  });
});

describe("POST /api/medications/intake parity", () => {
  it("11 a take in place", async () => {
    await post("11-take-in-place", {
      intakeId: ev.todayMorning,
      status: "taken",
      takenAt: "2026-10-15T08:30:00.000Z",
    });
  });

  it("12 a take that re-binds to another slot", async () => {
    await post("12-take-slot-move", {
      intakeId: ev.moveMe,
      status: "taken",
      takenAt: "2026-10-14T20:30:00.000Z",
    });
  });

  it("13 a pinned take, and a pin that is no slot", async () => {
    await post("13a-pin", {
      intakeId: ev.pinMe,
      status: "taken",
      takenAt: "2026-10-13T11:00:00.000Z",
      forceSlotInstant: "2026-10-13T08:00:00.000Z",
    });
    await post("13b-pin-not-a-slot", {
      intakeId: ev.snoozeMe,
      status: "taken",
      forceSlotInstant: "2026-10-11T15:00:00.000Z",
    });
  });

  it("14 a skip over a recorded dose", async () => {
    await post("14-skip", { intakeId: ev.skipMe, status: "skipped" });
  });

  it("15 a snooze with its end, and one without", async () => {
    await post("15a-snooze-until", {
      intakeId: ev.snoozeMe,
      status: "snoozed",
      snoozedUntil: "2026-10-15T13:00:00.000Z",
    });
    await post("15b-snooze-default", {
      intakeId: ev.snoozeMe,
      status: "snoozed",
    });
  });

  it("16 the not-found answers", async () => {
    await post("16a-unknown", {
      intakeId: "cmv0000000000000000000000",
      status: "taken",
    });
    await post("16b-foreign", { intakeId: ev.foreign, status: "taken" });
    await post("16c-tombstoned", { intakeId: ev.tombstoned, status: "taken" });
  });

  it("17 the record-only rule both ways", async () => {
    await post("17a-record-only-open", {
      intakeId: ev.recordOpen,
      status: "taken",
    });
    await post("17b-record-only-correction", {
      intakeId: ev.recordTaken,
      status: "taken",
      takenAt: "2026-10-13T07:20:00.000Z",
    });
  });

  it("18 the injection-site refusal, and an allowed site", async () => {
    await post("18a-site-not-allowed", {
      intakeId: ev.penToday,
      status: "taken",
      takenAt: "2026-10-15T09:15:00.000Z",
      injectionSite: "ABDOMEN_RIGHT",
    });
    await post("18b-site", {
      intakeId: ev.penToday,
      status: "taken",
      takenAt: "2026-10-15T09:15:00.000Z",
      injectionSite: "ABDOMEN_LEFT",
    });
  });

  it("19 a body the schema refuses", async () => {
    await post("19-invalid", { intakeId: "", status: "forgotten" });
  });

  it("20 a delegate who marks an open dose, a snooze, a correction, a reader and nobody", async () => {
    await post(
      "20a-writer-take",
      { intakeId: ev.todayEvening, status: "taken" },
      { ...writer },
    );
    await post(
      "20b-writer-snooze-refused",
      { intakeId: ev.snoozeMe, status: "snoozed" },
      writer,
    );
    await post(
      "20c-writer-correction-refused",
      { intakeId: ev.resolved, status: "skipped" },
      writer,
    );
    await post(
      "20d-reader",
      { intakeId: ev.snoozeMe, status: "taken" },
      reader,
    );
    await post(
      "20e-anonymous",
      { intakeId: ev.snoozeMe, status: "taken" },
      { auth: anonymous },
    );
  });
});
