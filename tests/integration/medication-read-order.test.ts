/**
 * Medication rows that tie on their sort key come back in one order.
 *
 * Postgres answers rows that tie on an `ORDER BY` in no particular order;
 * with nothing to break the tie a small table hands them back as they lie in
 * the heap, which is the order they were written in. Each case below writes
 * its tying rows in the opposite order to the one the read promises, so a read
 * that lost its tie-breaker answers the heap order and fails, and does so on
 * the first run rather than on an unlucky one:
 *
 *   - two medications created in the same millisecond (an import writes many)
 *     are listed newest first, then by id;
 *   - two schedules of one medication in the same window come back by id;
 *   - two of today's intakes on the same instant (two medications due at
 *     08:00) come back by id.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as listMedications } from "@/app/api/medications/route";
import { GET as listIntakes } from "@/app/api/medications/intake/route";

import { callRoute } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

const CREATED = new Date("2026-10-01T09:00:00.000Z");

beforeAll(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await truncateAllTables(prisma);
});

describe("medication reads with tying sort keys", () => {
  it("lists two medications created together newest first, then by id", async () => {
    const user = await makeUser({ timezone: "Europe/Berlin" });
    // Written a, then b; the list promises createdAt desc, id desc: b, a.
    for (const id of ["ord-med-a", "ord-med-b"]) {
      await prisma.medication.create({
        data: {
          id,
          userId: user.id,
          name: id,
          dose: "5 mg",
          createdAt: CREATED,
        },
      });
    }
    // Written b, then a, in one window; the list promises window, id: a, b.
    for (const id of ["ord-sched-b", "ord-sched-a"]) {
      await prisma.medicationSchedule.create({
        data: {
          id,
          medicationId: "ord-med-a",
          windowStart: "08:00",
          windowEnd: "09:00",
        },
      });
    }

    const res = await callRoute<
      Array<{ id: string; schedules: Array<{ id: string }> }>
    >(listMedications, {
      method: "GET",
      route: "/api/medications",
      auth: await makeSession(user),
    });
    expect(res.status).toBe(200);
    expect(res.data.map((m) => m.id)).toEqual(["ord-med-b", "ord-med-a"]);
    const a = res.data.find((m) => m.id === "ord-med-a")!;
    expect(a.schedules.map((s) => s.id)).toEqual([
      "ord-sched-a",
      "ord-sched-b",
    ]);
  });

  it("lists today's intakes on one instant by id", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const now = new Date();
    const due = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 1),
    );
    for (const [medicationId, intakeId] of [
      ["ord-today-med-1", "ord-intake-b"],
      ["ord-today-med-2", "ord-intake-a"],
    ] as const) {
      await prisma.medication.create({
        data: {
          id: medicationId,
          userId: user.id,
          name: medicationId,
          dose: "1",
        },
      });
      // Written b, then a; the read promises scheduledFor asc, id asc: a, b.
      await prisma.medicationIntakeEvent.create({
        data: {
          id: intakeId,
          userId: user.id,
          medicationId,
          scheduledFor: due,
          takenAt: due,
        },
      });
    }

    const res = await callRoute<Array<{ id: string }>>(listIntakes, {
      method: "GET",
      route: "/api/medications/intake",
      query: { scope: "today" },
      auth: await makeSession(user),
    });
    expect(res.status).toBe(200);
    expect(res.data.map((e) => e.id)).toEqual(["ord-intake-a", "ord-intake-b"]);
  });
});
