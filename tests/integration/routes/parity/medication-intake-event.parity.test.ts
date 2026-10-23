/**
 * Parity for `PUT` and `DELETE /api/medications/{id}/intake/{eventId}` while
 * the dose correction moves into `src/lib/medications/`.
 *
 * One record walks through the corrections the route tells apart, in order,
 * each request seeing what the earlier ones stored: a take recorded in place,
 * a take flipped to a skip, a correction that moves the dose to another slot
 * (tombstone and converge), a pin onto a free slot, the two pin refusals, an
 * unpin, an explicit slot, a take before the start day, a body the schema
 * refuses, the not-found answers, and the same correction from a delegate who
 * may only write and one who may manage. Then the deletes: the owner's, one
 * that reactivates a one-shot medication, the not-found answer, and both
 * delegates again. After each request the snapshot holds the response, the
 * wide event, the recorded tails and every medication row of the accounts.
 *
 * The clock is pinned (`Date` only), so the snapshot is the same on every
 * day it runs.
 */
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { DELETE, PUT } from "@/app/api/medications/[id]/intake/[eventId]/route";

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

// The cross-device push the route queues on a timer, recorded instead of run
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

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const ROUTE = "/api/medications/{id}/intake/{eventId}";

let ownerId: string;
let userIds: string[];
let owner: RouteAuth;
let writer: { auth: RouteAuth; headers: Record<string, string> };
let manager: { auth: RouteAuth; headers: Record<string, string> };
let medicationId: string;
let oneShotId: string;
const events: Record<string, string> = {};

async function put(
  name: string,
  eventId: string,
  body: unknown,
  options: {
    auth?: RouteAuth;
    headers?: Record<string, string>;
    medicationId?: string;
  } = {},
) {
  return parityStep({
    name: `medication-intake-event.${name}`,
    handler: PUT,
    options: {
      method: "PUT",
      route: ROUTE,
      params: { id: options.medicationId ?? medicationId, eventId },
      body,
      auth: options.auth ?? owner,
      headers: options.headers,
    },
    userIds,
    now: NOW,
  });
}

async function del(
  name: string,
  eventId: string,
  options: {
    auth?: RouteAuth;
    headers?: Record<string, string>;
    medicationId?: string;
  } = {},
) {
  return parityStep({
    name: `medication-intake-event.${name}`,
    handler: DELETE,
    options: {
      method: "DELETE",
      route: ROUTE,
      params: { id: options.medicationId ?? medicationId, eventId },
      auth: options.auth ?? owner,
      headers: options.headers,
    },
    userIds,
    now: NOW,
  });
}

async function intake(
  medication: string,
  key: string,
  data: {
    scheduledFor: string;
    takenAt?: string | null;
    skipped?: boolean;
    deletedAt?: string;
  },
) {
  const row = await prisma.medicationIntakeEvent.create({
    data: {
      userId: ownerId,
      medicationId: medication,
      scheduledFor: new Date(data.scheduledFor),
      takenAt: data.takenAt ? new Date(data.takenAt) : null,
      skipped: data.skipped ?? false,
      deletedAt: data.deletedAt ? new Date(data.deletedAt) : null,
    },
  });
  events[key] = row.id;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "UTC" });
  ownerId = user.id;
  owner = await makeSession(user);
  const created = new Date("2026-10-01T06:00:00.000Z");
  const medication = await makeMedication(
    user,
    {
      name: "Parity tablet",
      startsOn: new Date("2026-10-01"),
      createdAt: created,
      unitsPerDose: 1,
    },
    [
      { windowStart: "08:00", windowEnd: "10:00", label: "Morning" },
      { windowStart: "20:00", windowEnd: "22:00", label: "Evening" },
    ],
  );
  medicationId = medication.id;
  await prisma.medicationInventoryItem.create({
    data: {
      userId: ownerId,
      medicationId,
      unitsTotal: 30,
      unitsRemaining: 30,
      purchasedAt: created,
    },
  });
  const oneShot = await makeMedication(
    user,
    {
      name: "Parity one-shot",
      startsOn: new Date("2026-10-01"),
      createdAt: created,
      oneShot: true,
      active: false,
    },
    [{ windowStart: "09:00", windowEnd: "11:00" }],
  );
  oneShotId = oneShot.id;

  await intake(medicationId, "pending", {
    scheduledFor: "2026-10-13T08:00:00.000Z",
  });
  await intake(medicationId, "legacyTaken", {
    scheduledFor: "2026-10-13T20:00:00.000Z",
    takenAt: "2026-10-13T20:15:00.000Z",
  });
  await intake(medicationId, "morningTaken", {
    scheduledFor: "2026-10-14T08:00:00.000Z",
    takenAt: "2026-10-14T08:10:00.000Z",
  });
  await intake(medicationId, "eveningSkipped", {
    scheduledFor: "2026-10-14T20:00:00.000Z",
    skipped: true,
  });
  await intake(medicationId, "tombstoned", {
    scheduledFor: "2026-10-12T08:00:00.000Z",
    takenAt: "2026-10-12T08:05:00.000Z",
    deletedAt: "2026-10-12T09:00:00.000Z",
  });
  await intake(medicationId, "forDelete", {
    scheduledFor: "2026-10-11T08:00:00.000Z",
    takenAt: "2026-10-11T08:20:00.000Z",
  });
  await intake(medicationId, "forManagerDelete", {
    scheduledFor: "2026-10-11T20:00:00.000Z",
    takenAt: "2026-10-11T20:20:00.000Z",
  });
  await intake(oneShotId, "oneShotDose", {
    scheduledFor: "2026-10-10T09:00:00.000Z",
    takenAt: "2026-10-10T09:30:00.000Z",
  });

  const w = await delegateOf(prisma, user, "WRITE");
  const m = await delegateOf(prisma, user, "MANAGE");
  writer = { auth: w.auth, headers: w.headers };
  manager = { auth: m.auth, headers: m.headers };
  userIds = [ownerId, w.delegate.id, m.delegate.id];
});

afterAll(() => {
  vi.useRealTimers();
});

describe("PUT /api/medications/{id}/intake/{eventId} parity", () => {
  it("01 a pending dose taken inside its own window", async () => {
    await put("01-take-in-place", events.pending, {
      takenAt: "2026-10-13T08:40:00.000Z",
    });
  });

  it("02 the same dose flipped to a skip", async () => {
    await put("02-skip-flip", events.pending, { skipped: true });
  });

  it("03 a take corrected into the other window, onto a skipped slot", async () => {
    const res = await put("03-move-by-band", events.morningTaken, {
      takenAt: "2026-10-14T20:30:00.000Z",
    });
    events.moved = (res.data as { id: string }).id;
  });

  it("04 a legacy take pinned onto a free slot", async () => {
    const res = await put("04-pin-free-slot", events.legacyTaken, {
      forceSlotInstant: "2026-10-12T20:00:00.000Z",
    });
    events.pinned = (res.data as { id: string }).id;
  });

  it("05 a pin onto an instant that is no slot", async () => {
    await put("05-pin-not-a-slot", events.moved, {
      forceSlotInstant: "2026-10-12T15:00:00.000Z",
    });
  });

  it("06 a pin onto a slot another dose holds", async () => {
    await put("06-pin-occupied", events.moved, {
      forceSlotInstant: "2026-10-12T20:00:00.000Z",
    });
  });

  it("07 an unpin", async () => {
    const res = await put("07-unpin", events.pinned, {
      forceSlotInstant: null,
    });
    events.pinned = (res.data as { id: string }).id;
  });

  it("08 an explicit slot in the body", async () => {
    const res = await put("08-explicit-slot", events.moved, {
      scheduledFor: "2026-10-14T08:00:00.000Z",
      takenAt: "2026-10-14T08:45:00.000Z",
    });
    events.moved = (res.data as { id: string }).id;
  });

  it("09 a take before the start day", async () => {
    await put("09-before-start", events.pinned, {
      takenAt: "2026-09-20T08:00:00.000Z",
    });
  });

  it("10 a body the schema refuses", async () => {
    await put("10-invalid", events.pinned, {
      takenAt: "yesterday",
      skipped: "no",
    });
  });

  it("11 a tombstoned dose, and a dose under another medication", async () => {
    await put("11a-tombstoned", events.tombstoned, { skipped: true });
    await put(
      "11b-other-medication",
      events.pinned,
      { skipped: true },
      { medicationId: oneShotId },
    );
  });

  it("12 a delegate who may write, and one who may manage", async () => {
    await put(
      "12a-writer",
      events.pinned,
      { takenAt: "2026-10-13T20:50:00.000Z" },
      writer,
    );
    await put(
      "12b-manager",
      events.pinned,
      { takenAt: "2026-10-13T20:50:00.000Z" },
      manager,
    );
  });

  it("13 no credentials", async () => {
    await put(
      "13-anonymous",
      events.pinned,
      { skipped: true },
      {
        auth: anonymous,
      },
    );
  });
});

describe("DELETE /api/medications/{id}/intake/{eventId} parity", () => {
  it("21 the owner undoes a dose", async () => {
    await del("21-delete", events.forDelete);
  });

  it("22 undoing the only dose of a one-shot medication", async () => {
    await del("22-delete-one-shot", events.oneShotDose, {
      medicationId: oneShotId,
    });
  });

  it("23 a dose under another medication", async () => {
    await del("23-other-medication", events.forManagerDelete, {
      medicationId: oneShotId,
    });
  });

  it("24 a delegate who may write, and one who may manage", async () => {
    await del("24a-writer", events.forManagerDelete, writer);
    await del("24b-manager", events.forManagerDelete, manager);
  });

  it("25 no credentials", async () => {
    await del("25-anonymous", events.forDelete, { auth: anonymous });
  });
});
