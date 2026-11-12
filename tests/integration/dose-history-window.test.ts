/**
 * `GET /api/medications/{id}/dose-history` reads the window it shows, against
 * Postgres.
 *
 * Of the rows before the window only the latest take is read: a rolling grid
 * re-starts from it, and earlier takes place no slot in the window. So a
 * long history before the window answers the same ledger as a short one, and
 * a rolling medication last taken before the window shows the dose that fell
 * due inside it. All data invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getDoseHistory } from "@/app/api/medications/[id]/dose-history/route";

import { callRoute, type RouteAuth } from "../kit/call-route";
import { makeMedication, makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const TZ = "Europe/Berlin";
const DAY_MS = 86_400_000;
const FROM = new Date("2026-06-01T00:00:00Z");
const TO = new Date("2026-06-15T00:00:00Z");

interface LedgerBody {
  rows: Array<{ at: string; kind: string; status: string }>;
}

async function ledger(auth: RouteAuth, id: string) {
  const res = await callRoute<LedgerBody>(getDoseHistory, {
    method: "GET",
    route: "/api/medications/{id}/dose-history",
    params: { id },
    query: { from: FROM.toISOString(), to: TO.toISOString() },
    auth,
  });
  expect(res.status).toBe(200);
  return res.data.rows.map((r) => [r.at.slice(0, 10), r.kind, r.status]);
}

/** Doses taken on time at 08:00 Berlin (06:00 UTC in summer), one per day. */
async function takeOn(userId: string, medicationId: string, days: string[]) {
  await prisma.medicationIntakeEvent.createMany({
    data: days.map((day) => {
      const at = new Date(`${day}T06:00:00Z`);
      return {
        userId,
        medicationId,
        scheduledFor: at,
        takenAt: at,
        skipped: false,
        source: "WEB" as const,
      };
    }),
  });
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

beforeEach(async () => {
  await truncateAllTables(prisma);
});

describe("the dose history of a window", () => {
  it("re-starts a rolling grid from the latest take before the window", async () => {
    const user = await makeUser({ timezone: TZ });
    const auth = await makeSession(user);
    const med = await makeMedication(
      user,
      { createdAt: new Date("2026-01-01T00:00:00Z") },
      [
        {
          windowStart: "08:00",
          windowEnd: "08:00",
          timesOfDay: ["08:00"],
          rollingIntervalDays: 7,
        },
      ],
    );
    // Last taken four days before the window opens and not after: the next
    // dose was due inside the window and reads as missed there.
    await takeOn(user.id, med.id, ["2026-05-14", "2026-05-21", "2026-05-28"]);

    expect(await ledger(auth, med.id)).toEqual([
      ["2026-06-04", "slot", "missed"],
    ]);
  });

  it("answers the same ledger after a year of earlier takes", async () => {
    const user = await makeUser({ timezone: TZ });
    const auth = await makeSession(user);
    const daily = [
      {
        windowStart: "08:00",
        windowEnd: "08:00",
        timesOfDay: ["08:00"],
      },
    ];
    const created = { createdAt: new Date("2025-05-01T00:00:00Z") };
    const short = await makeMedication(user, created, daily);
    const long = await makeMedication(user, created, daily);
    const inWindow = ["2026-06-02", "2026-06-03", "2026-06-07"];
    await takeOn(user.id, short.id, ["2026-05-31", ...inWindow]);
    const yearBefore: string[] = [];
    for (let ms = Date.parse("2025-05-01"); ms <= Date.parse("2026-05-31");) {
      yearBefore.push(isoDay(ms));
      ms += DAY_MS;
    }
    await takeOn(user.id, long.id, [...yearBefore, ...inWindow]);

    const shortLedger = await ledger(auth, short.id);
    expect(shortLedger.filter((r) => r[2] === "taken_on_time")).toEqual(
      inWindow.map((day) => [day, "slot", "taken_on_time"]),
    );
    // The same ledger from the window's rows alone: reading every intake
    // also answers it, after a year of rows.
    const read = vi.spyOn(prisma.medicationIntakeEvent, "findMany");
    try {
      expect(await ledger(auth, long.id)).toEqual(shortLedger);
      const rows = await Promise.all(read.mock.results.map((r) => r.value));
      expect(rows.flat()).toHaveLength(inWindow.length);
    } finally {
      read.mockRestore();
    }
  });
});
