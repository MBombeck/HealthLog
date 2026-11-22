/**
 * The slot on the card's take button is the slot the server files the take
 * under, across a day.
 *
 * At noon the card read "Take (07:00 PM)" and posted the evening slot as
 * `scheduledFor`. The server does not bind a named slot that lies ahead of
 * the take, so it filed an extra dose, the card said "taken", and the 19:00
 * dose stayed open for its reminder. The card now binds every take by the
 * one take rule (`cardTakeSlot`): the named slot while the dose is open, a
 * pin onto it up to six hours ahead (the reach of the server's own
 * nearest-slot rule), an extra dose (said on the button, sent as
 * `extraDose`) beyond that.
 *
 * End to end: the real compliance read gives the card its current dose, the
 * card's own functions build the POST, the real intake route answers, and
 * the answer is compared with what the button said.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as complianceGET } from "@/app/api/medications/[id]/compliance/route";
import { POST as intakePOST } from "@/app/api/medications/[id]/intake/route";
import { cardIntakeBody } from "@/components/medications/use-medication-intake";
import { cardTakeSlot } from "@/lib/medications/dose-state/pill";

import { callRoute } from "../kit/call-route";
import { makeMedication, makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: () => {},
}));

const prisma = getPrismaClient();
const EVENING = new Date("2026-11-21T19:00:00.000Z");

beforeEach(() => truncateAllTables(prisma));
afterEach(() => {
  vi.useRealTimers();
});

interface CurrentDose {
  state: string | null;
  targetAt: string | null;
  dueAt: string | null;
  overdueSince: string | null;
  missedAfter: string | null;
}

async function takeAt(clock: string) {
  const now = new Date(`2026-11-21T${clock}:00.000Z`);
  vi.useFakeTimers({ now, toFake: ["Date"] });
  const user = await makeUser({ timezone: "UTC" });
  const auth = await makeSession(user);
  const medication = await makeMedication(
    user,
    { createdAt: new Date("2026-11-01T00:00:00.000Z") },
    [
      {
        windowStart: "19:00",
        windowEnd: "19:00",
        timesOfDay: ["19:00"],
        scheduleType: "SCHEDULED",
      },
    ],
  );

  const compliance = await callRoute<{
    complianceDisplay: { currentDose: CurrentDose };
  }>(complianceGET, {
    method: "GET",
    route: "/api/medications/{id}/compliance",
    params: { id: medication.id },
    auth,
  });
  expect(compliance.status).toBe(200);
  const dose = compliance.data.complianceDisplay.currentDose;
  const slot = cardTakeSlot(dose, dose.targetAt, now);
  expect(slot?.at.toISOString()).toBe(EVENING.toISOString());

  const res = await callRoute<{ scheduledFor: string; takenAt: string }>(
    intakePOST,
    {
      method: "POST",
      route: "/api/medications/{id}/intake",
      params: { id: medication.id },
      // A stable key keeps the route off its sixty-second duplicate check,
      // which compares the database's own clock with the pinned test clock.
      body: { ...cardIntakeBody(false, slot), idempotencyKey: `take-${clock}` },
      auth,
    },
  );
  expect(res.status).toBe(201);
  return { slot: slot!, filed: new Date(res.data.scheduledFor), now };
}

describe("a card take is filed under the slot its button names", () => {
  it.each(["13:00", "15:00", "17:30", "18:10", "21:00"])(
    "at %s the take counts for the 19:00 dose",
    async (clock) => {
      const { slot, filed } = await takeAt(clock);
      expect(slot.binding).not.toBe("extra");
      expect(filed.toISOString()).toBe(EVENING.toISOString());
    },
  );

  it.each(["11:59", "12:59"])(
    "at %s the button says extra dose, and the server files one",
    async (clock) => {
      const { slot, filed, now } = await takeAt(clock);
      expect(slot.binding).toBe("extra");
      // Filed at the take itself: the 19:00 dose stays open, as the button said.
      expect(filed.toISOString()).toBe(now.toISOString());
    },
  );
});

describe("an extra dose the person asks for", () => {
  async function setup(clock: string) {
    const now = new Date(`2026-11-21T${clock}:00.000Z`);
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const user = await makeUser({ timezone: "UTC" });
    const auth = await makeSession(user);
    const medication = await makeMedication(
      user,
      { createdAt: new Date("2026-11-01T00:00:00.000Z") },
      [{ windowStart: "19:00", windowEnd: "19:00", timesOfDay: ["19:00"] }],
    );
    return { now, auth, medication };
  }

  it("stays an extra dose inside the nearest-slot reach", async () => {
    // 15:00 is within six hours of 19:00: unnamed, the server would bind it.
    const { now, auth, medication } = await setup("15:00");
    const res = await callRoute<{ id: string; scheduledFor: string }>(
      intakePOST,
      {
        method: "POST",
        route: "/api/medications/{id}/intake",
        params: { id: medication.id },
        body: { skipped: false, extraDose: true, idempotencyKey: "extra-1" },
        auth,
      },
    );
    expect(res.status).toBe(201);
    expect(res.data.scheduledFor).toBe(now.toISOString());
    const row = await prisma.medicationIntakeEvent.findUniqueOrThrow({
      where: { id: res.data.id },
      select: { attributionSource: true },
    });
    // A released pin: no reader binds it to the 19:00 band afterwards.
    expect(row.attributionSource).toBe("USER_PIN");
  });

  it("refuses an extra dose that also names a slot", async () => {
    const { auth, medication } = await setup("15:00");
    const res = await callRoute(intakePOST, {
      method: "POST",
      route: "/api/medications/{id}/intake",
      params: { id: medication.id },
      body: {
        skipped: false,
        extraDose: true,
        forceSlotInstant: EVENING.toISOString(),
      },
      auth,
    });
    expect(res.status).toBe(422);
  });
});
