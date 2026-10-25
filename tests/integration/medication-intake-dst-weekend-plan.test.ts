/**
 * A Saturday + Sunday plan files each of its doses on its own slot in the
 * week of the autumn DST change.
 *
 * The plan starts the Sunday before the change, so its realised slots are
 * that Sunday, the Saturday before the change and the Sunday of the change.
 * Read around the Saturday dose, the ±24 h range ended at 06:00 UTC on the
 * Sunday while that Sunday's 08:00 slot is 07:00 UTC after the change. The
 * family probe ended at the range's end, so one pass called the plan weekly
 * and the wider one daily; the dose fell between them, was filed as
 * unscheduled, and the 60-second duplicate guard answered it with the
 * previous Sunday's row (200 instead of 201). The family is now read from a
 * window centred on the range, the same for both passes.
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

import { POST as createMedication } from "@/app/api/medications/route";
import { POST as recordIntake } from "@/app/api/medications/[id]/intake/route";

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

describe("backdated doses on a weekend plan across the autumn DST change", () => {
  it.each(["FREQ=WEEKLY;BYDAY=SA,SU", "FREQ=DAILY"])(
    "%s: every dose lands on its own slot",
    async (rrule) => {
      const user = await makeUser({ timezone: "Europe/Berlin" });
      const auth = await makeSession(user);
      vi.useFakeTimers({ toFake: ["Date"] });
      // 00:25 on Monday 2026-10-26 in Berlin.
      vi.setSystemTime(new Date("2026-10-25T23:25:00.000Z"));

      const created = await callRoute<{ id: string }>(createMedication, {
        method: "POST",
        route: "/api/medications",
        body: {
          name: `weekend ${rrule}`,
          dose: "5 mg",
          startsOn: "2026-10-18",
          schedules: [
            {
              windowStart: "08:00",
              windowEnd: "09:00",
              timesOfDay: ["08:00"],
              rrule,
            },
          ],
        },
        auth,
      });
      expect(created.status).toBe(201);
      const id = created.data.id;
      await prisma.medication.update({
        where: { id },
        data: { createdAt: new Date("2026-10-17T22:25:00.000Z") },
      });

      // 08:00 local on Sunday 18th (CEST), Saturday 24th (CEST) and Sunday
      // 25th (CET, after the change).
      for (const slot of [
        "2026-10-18T06:00:00.000Z",
        "2026-10-24T06:00:00.000Z",
        "2026-10-25T07:00:00.000Z",
      ]) {
        const res = await callRoute<{ scheduledFor: string }>(recordIntake, {
          method: "POST",
          route: "/api/medications/{id}/intake",
          params: { id },
          body: { skipped: false, scheduledFor: slot, takenAt: slot },
          auth,
        });
        expect(res.status, `the dose at ${slot} is written`).toBe(201);
        expect(res.data.scheduledFor).toBe(slot);
      }
    },
  );
});
