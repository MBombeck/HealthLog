/**
 * The cycle writes name the starts they fold in and give back (ios #116
 * item 9).
 *
 * A start logged a few days before an existing one is the same period entered
 * in the other order, so the later start is folded in. Taking the earlier one
 * back gives the later one back. Both used to reach only the audit row; the
 * client could refetch the grid but could not say which date moved. These
 * pin the answers: `absorbed` on the start, `restored` on the PATCH that
 * clears a start day's flow, and the opt-in 200 on the two deletes, with the
 * 204 unchanged for a client that does not ask.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-cycle-absorbed-integration-32-bytes-min-1234567890";
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const USER_ID = "user-cycle-absorbed";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "cycle-absorbed",
      email: "cycle-absorbed@example.test",
      gender: "FEMALE",
    },
  });
  const session = await getPrismaClient().session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

function request(
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function startPeriod(date: string): Promise<{
  cycle: { id: string; startDate: string } | null;
  absorbed: { cycleId: string; startDate: string } | null;
}> {
  const { POST } = await import("@/app/api/cycle/period/route");
  const res = await POST(
    request("/api/cycle/period", "POST", {
      action: "start",
      date,
      loggedAt: `${date}T08:00:00.000Z`,
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

async function cycleIdOn(date: string): Promise<string> {
  const row = await getPrismaClient().menstrualCycle.findFirstOrThrow({
    where: { userId: USER_ID, startDate: date },
    select: { id: true },
  });
  return row.id;
}

const PREFER = { prefer: "return=representation" };

describe("absorbed and restored cycle starts", () => {
  it("names the later start a start folds in, and null when it folds none", async () => {
    const first = await startPeriod("2026-09-17");
    expect(first.absorbed).toBeNull();
    const later = await cycleIdOn("2026-09-17");

    const earlier = await startPeriod("2026-09-14");
    expect(earlier.absorbed).toEqual({
      cycleId: later,
      startDate: "2026-09-17",
    });
  });

  it("gives the folded start back on a cycle delete with Prefer, as 200", async () => {
    await startPeriod("2026-09-17");
    const later = await cycleIdOn("2026-09-17");
    await startPeriod("2026-09-14");
    const earlier = await cycleIdOn("2026-09-14");

    const { DELETE } = await import("@/app/api/cycle/cycles/[id]/route");
    const res = await DELETE(
      request(`/api/cycle/cycles/${earlier}`, "DELETE", undefined, PREFER),
      { params: Promise.resolve({ id: earlier }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("preference-applied")).toBe("return=representation");
    expect((await res.json()).data).toEqual({
      removedCycleId: earlier,
      restored: [{ cycleId: later, startDate: "2026-09-17" }],
    });
    // The calendar shows 17 Sep again.
    const live = await getPrismaClient().menstrualCycle.findMany({
      where: { userId: USER_ID, deletedAt: null },
      select: { startDate: true },
    });
    expect(live.map((c) => c.startDate)).toEqual(["2026-09-17"]);
  });

  it("keeps answering 204 without a body when the request does not ask", async () => {
    await startPeriod("2026-09-17");
    await startPeriod("2026-09-14");
    const earlier = await cycleIdOn("2026-09-14");

    const { DELETE } = await import("@/app/api/cycle/cycles/[id]/route");
    const res = await DELETE(
      request(`/api/cycle/cycles/${earlier}`, "DELETE"),
      { params: Promise.resolve({ id: earlier }) },
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("preference-applied")).toBeNull();
    expect(await res.text()).toBe("");
  });

  it("answers a repeated delete with nothing removed and nothing restored", async () => {
    await startPeriod("2026-09-17");
    const id = await cycleIdOn("2026-09-17");
    const { DELETE } = await import("@/app/api/cycle/cycles/[id]/route");
    await DELETE(request(`/api/cycle/cycles/${id}`, "DELETE"), {
      params: Promise.resolve({ id }),
    });
    const again = await DELETE(
      request(`/api/cycle/cycles/${id}`, "DELETE", undefined, PREFER),
      { params: Promise.resolve({ id }) },
    );
    expect(again.status).toBe(200);
    expect((await again.json()).data).toEqual({
      removedCycleId: null,
      restored: [],
    });
  });

  it("gives the folded start back on a day-log delete with Prefer", async () => {
    await startPeriod("2026-09-17");
    const later = await cycleIdOn("2026-09-17");
    await startPeriod("2026-09-14");
    const earlier = await cycleIdOn("2026-09-14");
    const dayLog = await getPrismaClient().cycleDayLog.findFirstOrThrow({
      where: { userId: USER_ID, date: "2026-09-14" },
      select: { id: true },
    });

    const { DELETE } = await import("@/app/api/cycle/day-logs/[id]/route");
    const res = await DELETE(
      request(`/api/cycle/day-logs/${dayLog.id}`, "DELETE", undefined, {
        prefer: "handling=lenient, return=representation",
      }),
      { params: Promise.resolve({ id: dayLog.id }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      removedCycleId: earlier,
      restored: [{ cycleId: later, startDate: "2026-09-17" }],
    });
  });

  it("names the start given back when an edit clears the flow on a start day", async () => {
    await startPeriod("2026-09-17");
    const later = await cycleIdOn("2026-09-17");
    await startPeriod("2026-09-14");
    const dayLog = await getPrismaClient().cycleDayLog.findFirstOrThrow({
      where: { userId: USER_ID, date: "2026-09-14" },
      select: { id: true },
    });

    const { PATCH } = await import("@/app/api/cycle/day-logs/[id]/route");
    const res = await PATCH(
      request(`/api/cycle/day-logs/${dayLog.id}`, "PATCH", { flow: "NONE" }),
      { params: Promise.resolve({ id: dayLog.id }) },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.restored).toEqual([
      { cycleId: later, startDate: "2026-09-17" },
    ]);
    expect(data.id).toBe(dayLog.id);
  });

  it("answers an edit that removes no start with an empty list", async () => {
    await startPeriod("2026-09-17");
    const dayLog = await getPrismaClient().cycleDayLog.findFirstOrThrow({
      where: { userId: USER_ID, date: "2026-09-17" },
      select: { id: true },
    });
    const { PATCH } = await import("@/app/api/cycle/day-logs/[id]/route");
    const res = await PATCH(
      request(`/api/cycle/day-logs/${dayLog.id}`, "PATCH", { flow: "HEAVY" }),
      { params: Promise.resolve({ id: dayLog.id }) },
    );
    expect((await res.json()).data.restored).toEqual([]);
  });
});
