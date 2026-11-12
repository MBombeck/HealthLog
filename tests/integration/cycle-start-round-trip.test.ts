/**
 * Logging a period start and taking it back has to leave the record where it
 * found it.
 *
 * `action:"start"` does not only insert a cycle. It CLOSES the previous open
 * one — stamps its `endDate` and `lengthDays` from the new start — and, when
 * the start is back-filled between two existing cycles, re-anchors the one
 * after it too. Nothing undid any of that. Deleting the start left the
 * previous cycle standing as a closed torso, and a record whose last cycle is
 * closed has no open cycle to forecast from, so the prediction disappeared and
 * did not come back. There is no way to repair that from the app.
 *
 * So this is a round trip, not a delete test: it photographs every cycle row
 * before the start is logged, logs it, removes it, and asserts the rows are
 * back to the photograph field by field. Two removal paths reach a start —
 * deleting the cycle, and deleting the day-log that opened it from the log
 * sheet, which is the only one the web actually offers.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-cycle-round-trip-integration-32-bytes-min-1234567890";
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const USER_ID = "user-cycle-round-trip";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

async function loginAs(userId: string): Promise<void> {
  cookieJar.clear();
  headerJar.clear();
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "cycle-round-trip",
      email: "cycle-round-trip@example.test",
      gender: "FEMALE",
    },
  });
});

function jsonRequest(
  path: string,
  method: string,
  body?: unknown,
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** The cycle boundary state, which is exactly what a start write moves. */
interface CycleShape {
  startDate: string;
  endDate: string | null;
  lengthDays: number | null;
  periodEndDate: string | null;
  deletedAt: boolean;
}

async function cycleShapes(): Promise<CycleShape[]> {
  const rows = await getPrismaClient().menstrualCycle.findMany({
    where: { userId: USER_ID },
    orderBy: { startDate: "asc" },
    select: {
      startDate: true,
      endDate: true,
      lengthDays: true,
      periodEndDate: true,
      deletedAt: true,
    },
  });
  return rows.map((r) => ({
    startDate: r.startDate,
    endDate: r.endDate,
    lengthDays: r.lengthDays,
    periodEndDate: r.periodEndDate,
    deletedAt: r.deletedAt !== null,
  }));
}

/** Only the cycles a read would see — a tombstone is not part of the record. */
async function liveShapes(): Promise<CycleShape[]> {
  return (await cycleShapes()).filter((c) => !c.deletedAt);
}

async function startPeriod(date: string): Promise<Response> {
  const { POST } = await import("@/app/api/cycle/period/route");
  return POST(
    jsonRequest("/api/cycle/period", "POST", {
      action: "start",
      date,
      loggedAt: `${date}T08:00:00.000Z`,
    }),
  );
}

/** Three months of history, the shape the bug needed. */
async function seedHistory(): Promise<void> {
  await startPeriod("2026-05-04");
  await startPeriod("2026-06-01");
  await startPeriod("2026-07-01");
}

describe("logging a period start and taking it back", () => {
  it("re-opens the previous cycle when the start's own cycle is deleted", async () => {
    await loginAs(USER_ID);
    await seedHistory();
    const before = await liveShapes();
    // The July cycle is open — that is the state the record has to return to.
    expect(before.at(-1)).toEqual({
      startDate: "2026-07-01",
      endDate: null,
      lengthDays: null,
      periodEndDate: null,
      deletedAt: false,
    });

    await startPeriod("2026-08-07");
    const during = await liveShapes();
    expect(during).toHaveLength(4);
    // The July cycle really was closed by the new start, so the delete below
    // has something to undo.
    expect(during.at(-2)).toMatchObject({
      startDate: "2026-07-01",
      endDate: "2026-08-06",
      lengthDays: 37,
    });

    const added = await getPrismaClient().menstrualCycle.findFirstOrThrow({
      where: { userId: USER_ID, startDate: "2026-08-07" },
      select: { id: true },
    });
    const { DELETE } = await import("@/app/api/cycle/cycles/[id]/route");
    const res = await DELETE(
      jsonRequest(`/api/cycle/cycles/${added.id}`, "DELETE"),
      { params: Promise.resolve({ id: added.id }) },
    );
    expect(res.status).toBe(204);

    expect(await liveShapes()).toEqual(before);
  });

  it("re-opens the previous cycle when the start's day-log is deleted", async () => {
    // The path the web actually offers: the log sheet's delete button removes
    // the day-log, and the cycle that one tap opened has to go with it.
    await loginAs(USER_ID);
    await seedHistory();
    const before = await liveShapes();

    await startPeriod("2026-08-07");
    expect(await liveShapes()).toHaveLength(4);

    const dayLog = await getPrismaClient().cycleDayLog.findFirstOrThrow({
      where: { userId: USER_ID, date: "2026-08-07" },
      select: { id: true },
    });
    const { DELETE } = await import("@/app/api/cycle/day-logs/[id]/route");
    const res = await DELETE(
      jsonRequest(`/api/cycle/day-logs/${dayLog.id}`, "DELETE"),
      { params: Promise.resolve({ id: dayLog.id }) },
    );
    expect(res.status).toBe(204);

    expect(await liveShapes()).toEqual(before);
  });

  it("restores the boundary a back-filled start took from BOTH neighbours", async () => {
    // A start inserted between two existing cycles closes the one before it
    // and takes its own end from the one after. Removing it has to hand the
    // whole span back to the earlier cycle.
    await loginAs(USER_ID);
    await seedHistory();
    await startPeriod("2026-08-07");
    const before = await liveShapes();

    await startPeriod("2026-06-15");
    const during = await liveShapes();
    expect(during).toHaveLength(5);
    expect(during[1]).toMatchObject({
      startDate: "2026-06-01",
      endDate: "2026-06-14",
      lengthDays: 14,
    });
    expect(during[2]).toMatchObject({
      startDate: "2026-06-15",
      endDate: "2026-06-30",
      lengthDays: 16,
    });

    const inserted = await getPrismaClient().menstrualCycle.findFirstOrThrow({
      where: { userId: USER_ID, startDate: "2026-06-15" },
      select: { id: true },
    });
    const { DELETE } = await import("@/app/api/cycle/cycles/[id]/route");
    await DELETE(jsonRequest(`/api/cycle/cycles/${inserted.id}`, "DELETE"), {
      params: Promise.resolve({ id: inserted.id }),
    });

    expect(await liveShapes()).toEqual(before);
  });

  it("gives back the start a mis-tapped earlier start folded in", async () => {
    // A start a few days after another is the same period entered late, so
    // the earlier tap folds it in. When the earlier tap was the mistake,
    // taking it back has to bring the real start back too, not reopen the
    // cycle before it.
    await loginAs(USER_ID);
    await seedHistory();
    await startPeriod("2026-08-10");
    const before = await liveShapes();
    const realStart = await getPrismaClient().menstrualCycle.findFirstOrThrow({
      where: { userId: USER_ID, startDate: "2026-08-10" },
      select: { id: true },
    });

    await startPeriod("2026-08-05");
    const during = await liveShapes();
    expect(during.map((c) => c.startDate)).not.toContain("2026-08-10");
    expect(during.at(-1)?.startDate).toBe("2026-08-05");

    const misTap = await getPrismaClient().menstrualCycle.findFirstOrThrow({
      where: { userId: USER_ID, startDate: "2026-08-05" },
      select: { id: true },
    });
    const { DELETE } = await import("@/app/api/cycle/cycles/[id]/route");
    const res = await DELETE(
      jsonRequest(`/api/cycle/cycles/${misTap.id}`, "DELETE"),
      { params: Promise.resolve({ id: misTap.id }) },
    );
    expect(res.status).toBe(204);

    expect(await liveShapes()).toEqual(before);
    // The real start's own day is its own again.
    const dayLog = await getPrismaClient().cycleDayLog.findFirstOrThrow({
      where: { userId: USER_ID, date: "2026-08-10" },
      select: { cycleId: true },
    });
    expect(dayLog.cycleId).toBe(realStart.id);
  });

  it("gives back the folded start when the mis-tap's day-log is deleted", async () => {
    await loginAs(USER_ID);
    await seedHistory();
    await startPeriod("2026-08-10");
    const before = await liveShapes();

    await startPeriod("2026-08-05");
    const dayLog = await getPrismaClient().cycleDayLog.findFirstOrThrow({
      where: { userId: USER_ID, date: "2026-08-05" },
      select: { id: true },
    });
    const { DELETE } = await import("@/app/api/cycle/day-logs/[id]/route");
    const res = await DELETE(
      jsonRequest(`/api/cycle/day-logs/${dayLog.id}`, "DELETE"),
      { params: Promise.resolve({ id: dayLog.id }) },
    );
    expect(res.status).toBe(204);

    expect(await liveShapes()).toEqual(before);
  });

  it("leaves a day-log that opened no cycle alone", async () => {
    // A plain entry on a day that is not a cycle start must not take a cycle
    // with it when it is deleted.
    await loginAs(USER_ID);
    await seedHistory();
    const before = await liveShapes();

    const { POST } = await import("@/app/api/cycle/day-logs/route");
    await POST(
      jsonRequest("/api/cycle/day-logs", "POST", {
        date: "2026-07-14",
        flow: "SPOTTING",
        loggedAt: "2026-07-14T08:00:00.000Z",
      }),
    );
    const dayLog = await getPrismaClient().cycleDayLog.findFirstOrThrow({
      where: { userId: USER_ID, date: "2026-07-14" },
      select: { id: true },
    });
    const { DELETE } = await import("@/app/api/cycle/day-logs/[id]/route");
    await DELETE(jsonRequest(`/api/cycle/day-logs/${dayLog.id}`, "DELETE"), {
      params: Promise.resolve({ id: dayLog.id }),
    });

    expect(await liveShapes()).toEqual(before);
  });

  it("gives the forecast back", async () => {
    // The symptom the round trip exists for: after the start is taken back the
    // engine must forecast again, from the same open cycle as before.
    await loginAs(USER_ID);
    await seedHistory();

    const { GET } = await import("@/app/api/cycle/calendar/route");
    const readForecast = async (): Promise<string | null> => {
      const res = await GET(
        new NextRequest("http://localhost/api/cycle/calendar"),
      );
      const body = JSON.parse(await res.text());
      return body.data?.prediction?.nextPeriodStart ?? null;
    };

    const before = await readForecast();
    expect(before).not.toBeNull();

    await startPeriod("2026-08-07");
    const dayLog = await getPrismaClient().cycleDayLog.findFirstOrThrow({
      where: { userId: USER_ID, date: "2026-08-07" },
      select: { id: true },
    });
    const { DELETE } = await import("@/app/api/cycle/day-logs/[id]/route");
    await DELETE(jsonRequest(`/api/cycle/day-logs/${dayLog.id}`, "DELETE"), {
      params: Promise.resolve({ id: dayLog.id }),
    });

    expect(await readForecast()).toBe(before);
  });
});
