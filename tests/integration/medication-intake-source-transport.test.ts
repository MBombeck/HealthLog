/**
 * The `source` of an intake row says which transport wrote it, never which
 * code path: a take the app sends with its Bearer token stores `API`, one
 * from the browser `WEB`. A status take that moves the dose to another slot
 * creates the row it lands on, and that row was stamped `WEB` for every
 * caller, so a dose taken in the app read as a web dose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as statusPost } from "@/app/api/medications/intake/route";
import { callRoute, type RouteAuth } from "../kit/call-route";
import { makeSession, makeToken, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: () => {},
}));

const DAY_MS = 24 * 3600_000;
// 13:30 in Berlin. Doses at 08:00 and 13:00, neither taken.
const NOW = new Date("2026-11-21T12:30:00.000Z");
const MORNING = new Date("2026-11-21T07:00:00.000Z");
const MIDDAY = new Date("2026-11-21T12:00:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const prisma = getPrismaClient();
  const user = await makeUser({ timezone: "Europe/Berlin" });
  const med = await prisma.medication.create({
    data: {
      userId: user.id,
      name: "Ramipril",
      dose: "5 mg",
      active: true,
      startsOn: new Date(Date.now() - 30 * DAY_MS),
      createdAt: new Date(Date.now() - 30 * DAY_MS),
      schedules: {
        create: {
          windowStart: "08:00",
          windowEnd: "08:00",
          timesOfDay: ["08:00", "13:00"],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  const morning = await prisma.medicationIntakeEvent.create({
    data: {
      userId: user.id,
      medicationId: med.id,
      scheduledFor: MORNING,
      source: "REMINDER",
    },
  });
  return { user, medId: med.id, morningId: morning.id };
}

async function takeOntoMidday(auth: RouteAuth, intakeId: string) {
  const res = await callRoute(statusPost, {
    method: "POST",
    route: "/api/medications/intake",
    auth,
    body: {
      intakeId,
      status: "taken",
      forceSlotInstant: MIDDAY.toISOString(),
    },
  });
  expect(res.status).toBe(200);
  return getPrismaClient().medicationIntakeEvent.findFirstOrThrow({
    where: { scheduledFor: MIDDAY, deletedAt: null },
    select: { source: true, takenVia: true, takenAt: true },
  });
}

describe("a status take moved onto another slot", () => {
  it("stores API and APP for the app's Bearer token", async () => {
    const { user, morningId } = await setup();
    const row = await takeOntoMidday(await makeToken(user), morningId);
    expect(row).toMatchObject({ source: "API", takenVia: "APP" });
    expect(row.takenAt).not.toBeNull();
  });

  it("stores WEB for a browser session", async () => {
    const { user, morningId } = await setup();
    const row = await takeOntoMidday(await makeSession(user), morningId);
    expect(row).toMatchObject({ source: "WEB", takenVia: "WEB" });
  });
});
