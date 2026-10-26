/**
 * Today's intake list spans the real local day on a DST change.
 *
 * Europe/Berlin's autumn change day lasts 25 hours, the spring one 23. The
 * list used to end 24 hours after local midnight, so on the long day a dose
 * at 23:30 was missing from it (nothing could be offered from the list in
 * that last hour), and on the short day it reached an hour into tomorrow.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { GET as listIntakes } from "@/app/api/medications/intake/route";

import { callRoute } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

beforeAll(async () => {
  await truncateAllTables(prisma);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await truncateAllTables(prisma);
});

async function todayIds(
  now: string,
  doses: Record<string, string>,
): Promise<string[]> {
  const user = await makeUser({ timezone: "Europe/Berlin" });
  const auth = await makeSession(user);
  for (const [id, scheduledFor] of Object.entries(doses)) {
    await prisma.medication.create({
      data: { id: `${id}-med`, userId: user.id, name: id, dose: "1" },
    });
    await prisma.medicationIntakeEvent.create({
      data: {
        id,
        userId: user.id,
        medicationId: `${id}-med`,
        scheduledFor: new Date(scheduledFor),
      },
    });
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  const res = await callRoute<Array<{ id: string }>>(listIntakes, {
    method: "GET",
    route: "/api/medications/intake",
    query: { scope: "today" },
    auth,
  });
  expect(res.status).toBe(200);
  return res.data.map((e) => e.id).sort();
}

describe("GET /api/medications/intake?scope=today across a DST change", () => {
  it("keeps the last hour of the 25-hour autumn day", async () => {
    // 2026-10-25 in Berlin runs from 22:00 UTC on the 24th to 23:00 UTC.
    const ids = await todayIds("2026-10-25T22:40:00.000Z", {
      "dst-autumn-morning": "2026-10-25T07:00:00.000Z", // 08:00 CET
      "dst-autumn-late": "2026-10-25T22:30:00.000Z", // 23:30 CET
      "dst-autumn-tomorrow": "2026-10-25T23:30:00.000Z", // 00:30 on the 26th
    });
    expect(ids).toEqual(["dst-autumn-late", "dst-autumn-morning"]);
  });

  it("stops at midnight on the 23-hour spring day", async () => {
    // 2026-03-29 in Berlin runs from 23:00 UTC on the 28th to 22:00 UTC.
    const ids = await todayIds("2026-03-29T21:40:00.000Z", {
      "dst-spring-late": "2026-03-29T21:30:00.000Z", // 23:30 CEST
      "dst-spring-tomorrow": "2026-03-29T22:30:00.000Z", // 00:30 on the 30th
    });
    expect(ids).toEqual(["dst-spring-late"]);
  });
});
