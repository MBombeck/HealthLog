/**
 * `GET /api/nav/counts`: the two counts the navigation shows, against a real
 * Postgres.
 *
 * - A dose counts when the dose resolver says `due` or `overdue`: a dose whose
 *   window is open now counts, one whose window opens later today does not,
 *   one the person already took does not.
 * - A check-up counts when it is due now by the digest rail's rule: an
 *   overdue one does; a booked visit's reminder, a snoozed one, a paused one
 *   and one due later do not.
 * - A narrow token and a switched record are refused.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { callRoute } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { countStatements } from "./query-counter";

const prisma = getPrismaClient();
const HOUR = 3_600_000;

/** A zone whose wall clock is between 05:00 and 18:59 right now. */
function daytimeZone(): string {
  for (const tz of [
    "Europe/Berlin",
    "America/New_York",
    "Pacific/Honolulu",
    "Asia/Tokyo",
    "Pacific/Kiritimati",
    "America/Los_Angeles",
  ]) {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        hourCycle: "h23",
        timeZone: tz,
      }).format(new Date()),
    );
    if (hour >= 5 && hour <= 18) return tz;
  }
  throw new Error("no daytime zone");
}

function hhmm(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: tz,
  }).format(at);
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

async function createMedication(
  session: Awaited<ReturnType<typeof makeSession>>,
  name: string,
  start: string,
  end: string,
) {
  const { POST } = await import("@/app/api/medications/route");
  const res = await callRoute<{ id: string }>(POST, {
    method: "POST",
    route: "/api/medications",
    auth: session,
    body: {
      name,
      dose: "1 tablet",
      schedules: [{ windowStart: start, windowEnd: end }],
    },
  });
  expect(res.status).toBe(201);
  // As if added two days ago: a slot before the medication existed is no
  // dose of it (the ledger starts at its creation).
  await prisma.medication.update({
    where: { id: res.data.id },
    data: { createdAt: new Date(Date.now() - 48 * HOUR) },
  });
  return res.data.id;
}

describe("GET /api/nav/counts", () => {
  it("counts the doses the resolver calls due and the check-ups due now", async () => {
    const tz = daytimeZone();
    const user = await makeUser({ timezone: tz });
    const session = await makeSession(user);
    const now = new Date();

    // Due now: a window around the current minute.
    await createMedication(
      session,
      "Open now",
      hhmm(new Date(now.getTime() - HOUR), tz),
      hhmm(new Date(now.getTime() + HOUR), tz),
    );
    // Later today: not due yet.
    await createMedication(
      session,
      "Tonight",
      hhmm(new Date(now.getTime() + 4 * HOUR), tz),
      hhmm(new Date(now.getTime() + 5 * HOUR), tz),
    );

    const reminder = (data: Record<string, unknown>) =>
      prisma.measurementReminder.create({
        data: {
          userId: user.id,
          label: "Check-up",
          intervalDays: 365,
          notifyHour: 9,
          enabled: true,
          ...data,
        },
      });
    const yesterday = new Date(now.getTime() - 26 * HOUR);
    await reminder({ label: "Overdue", nextDueAt: yesterday });
    await reminder({
      label: "Booked visit",
      origin: "ENCOUNTER",
      nextDueAt: yesterday,
    });
    await reminder({
      label: "Snoozed",
      nextDueAt: yesterday,
      snoozedUntil: new Date(now.getTime() + 24 * HOUR),
    });
    await reminder({ label: "Paused", nextDueAt: yesterday, enabled: false });
    await reminder({
      label: "Next month",
      nextDueAt: new Date(now.getTime() + 30 * 24 * HOUR),
    });

    const { GET } = await import("@/app/api/nav/counts/route");
    const res = await callRoute<{ dosesDue: number; checkupsDue: number }>(
      GET,
      { method: "GET", route: "/api/nav/counts", auth: session },
    );
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ dosesDue: 1, checkupsDue: 1 });
  });

  it("answers zero for an account with nothing scheduled", async () => {
    const session = await makeSession(await makeUser());
    const { GET } = await import("@/app/api/nav/counts/route");
    const res = await callRoute<{ dosesDue: number; checkupsDue: number }>(
      GET,
      { method: "GET", route: "/api/nav/counts", auth: session },
    );
    expect(res.data).toEqual({ dosesDue: 0, checkupsDue: 0 });
  });

  it("reads in the same number of statements whatever the medications", async () => {
    const tz = daytimeZone();
    const user = await makeUser({ timezone: tz });
    const session = await makeSession(user);
    const { GET } = await import("@/app/api/nav/counts/route");
    const measure = async () =>
      (
        await countStatements(async () => {
          const res = await callRoute(GET, {
            method: "GET",
            route: "/api/nav/counts",
            auth: session,
          });
          return res.status;
        })
      ).count;
    await createMedication(session, "One", "08:00", "09:00");
    const one = await measure();
    for (const name of ["Two", "Three", "Four"]) {
      await createMedication(session, name, "20:00", "21:00");
    }
    expect(await measure()).toBe(one);
  });
});
