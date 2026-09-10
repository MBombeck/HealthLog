/**
 * v1.37.20 (#223 / iOS #68) — the skip, snooze and history routes.
 *
 * What this suite pins, per the feature's design:
 *
 *   - 404 for a foreign or ENCOUNTER-origin reminder on all three routes
 *     (the refusal lives in the lookup, before any write).
 *   - A SCREENING reminder is skippable and snoozable — deliberately NO 409.
 *     The satisfy-side 409 guards against CLAIMED fulfilment without an
 *     assessment; skip and snooze claim the opposite, so refusing them here
 *     would only push people back to deleting the reminder. This test is the
 *     pinned boundary between the two rules.
 *   - Skip: forward-only no-op behind an existing cursor; the write never
 *     carries `lastSatisfiedAt` (THE invariant); the SKIPPED ledger row.
 *   - Snooze: the named calendar day resolves to the notifyHour in the
 *     profile timezone; both cursors move to the SAME instant; a past date
 *     and a beyond-cap date answer 422; the cadence fields stay untouched.
 *   - History: paginated newest-first with the meta triple.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1", locale: "en" } })),
  requireRecordAuth: vi.fn(async () => ({
    user: { id: "u1", locale: "en" },
    actor: { id: "u1", locale: "en" },
    grantId: null,
  })),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

const findFirstMock = vi.fn();
const updateMock = vi.fn();
const updateManyMock = vi.fn();
const findUniqueOrThrowMock = vi.fn();
const findUserMock = vi.fn();
const eventCreateMock = vi.fn();
const eventFindManyMock = vi.fn();
const eventCountMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    measurementReminder: {
      findFirst: (...a: unknown[]) => findFirstMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
      updateMany: (...a: unknown[]) => updateManyMock(...a),
      findUniqueOrThrow: (...a: unknown[]) => findUniqueOrThrowMock(...a),
    },
    measurementReminderEvent: {
      create: (...a: unknown[]) => eventCreateMock(...a),
      findMany: (...a: unknown[]) => eventFindManyMock(...a),
      count: (...a: unknown[]) => eventCountMock(...a),
    },
    user: { findUnique: (...a: unknown[]) => findUserMock(...a) },
  },
}));

import { POST as SKIP } from "../skip/route";
import { POST as SNOOZE } from "../snooze/route";
import { GET as HISTORY } from "../history/route";

const NOW = new Date("2026-06-15T08:00:00.000Z");

const BASE_ROW = {
  id: "r1",
  userId: "u1",
  label: "Blutdruck messen",
  measurementType: "BLOOD_PRESSURE_SYS",
  intervalDays: 30,
  rrule: null as string | null,
  anchorDate: null as Date | null,
  endsOn: null,
  origin: "VORSORGE",
  notifyHour: 9,
  location: null,
  nextDueAt: new Date("2026-06-15T07:00:00Z"),
  lastSatisfiedAt: null as Date | null,
  snoozedUntil: null as Date | null,
  lastSkippedAt: null as Date | null,
  skipCount: 0,
  enabled: true,
  vaccinationAntigen: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  deletedAt: null,
};

function params(id = "r1") {
  return { params: Promise.resolve({ id }) };
}

function skipRequest(): NextRequest {
  return new NextRequest("http://localhost/api/measurement-reminders/r1/skip", {
    method: "POST",
  });
}

function snoozeRequest(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/measurement-reminders/r1/snooze",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

function historyRequest(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/measurement-reminders/r1/history${query}`,
    { method: "GET" },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  findFirstMock.mockResolvedValue({ ...BASE_ROW });
  findUserMock.mockResolvedValue({ timezone: "Europe/Berlin" });
  updateManyMock.mockResolvedValue({ count: 1 });
  updateMock.mockResolvedValue({ ...BASE_ROW });
  findUniqueOrThrowMock.mockResolvedValue({ ...BASE_ROW });
  eventCreateMock.mockResolvedValue({ id: "evt-1" });
  eventFindManyMock.mockResolvedValue([]);
  eventCountMock.mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("POST /api/measurement-reminders/[id]/skip", () => {
  it("404s a foreign reminder without touching it", async () => {
    findFirstMock.mockResolvedValue({ ...BASE_ROW, userId: "someone-else" });
    const res = await SKIP(skipRequest(), params());
    expect(res.status).toBe(404);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("404s an ENCOUNTER reminder via the lookup filter", async () => {
    // The route's findFirst carries `origin: { not: "ENCOUNTER" }`, so the
    // DB answers null for an appointment row. Mirror that here.
    findFirstMock.mockResolvedValue(null);
    const res = await SKIP(skipRequest(), params());
    expect(res.status).toBe(404);
    const where = findFirstMock.mock.calls[0][0].where;
    expect(where.origin).toEqual({ not: "ENCOUNTER" });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("skips a SCREENING reminder — the satisfy-side 409 does not apply", async () => {
    findFirstMock.mockResolvedValue({
      ...BASE_ROW,
      measurementType: "PHQ9_SCORE",
    });
    const res = await SKIP(skipRequest(), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.skipped).toBe(true);
  });

  it("stamps the skip without ever touching lastSatisfiedAt", async () => {
    const res = await SKIP(skipRequest(), params());
    expect(res.status).toBe(200);
    const { data } = updateManyMock.mock.calls[0][0];
    expect(data.lastSkippedAt).toEqual(NOW);
    expect(data.skipCount).toEqual({ increment: 1 });
    expect(data.snoozedUntil).toBeNull();
    expect("lastSatisfiedAt" in data).toBe(false);
    // Rolling 30d cadence restarts from the skip instant.
    expect(data.nextDueAt.getTime()).toBeGreaterThan(
      NOW.getTime() + 29 * 24 * 60 * 60 * 1000,
    );
  });

  it("appends the SKIPPED ledger row", async () => {
    await SKIP(skipRequest(), params());
    expect(eventCreateMock).toHaveBeenCalledTimes(1);
    const { data } = eventCreateMock.mock.calls[0][0];
    expect(data).toMatchObject({
      userId: "u1",
      reminderId: "r1",
      kind: "SKIPPED",
      source: "skip",
    });
  });

  it("answers skipped=false on a forward-only no-op (double skip)", async () => {
    findFirstMock.mockResolvedValue({
      ...BASE_ROW,
      // A cursor already ahead of the clock — the primitive refuses in
      // memory, before any write.
      lastSkippedAt: new Date("2026-06-16T09:00:00Z"),
    });
    const res = await SKIP(skipRequest(), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.skipped).toBe(false);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(eventCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/measurement-reminders/[id]/snooze", () => {
  it("404s an ENCOUNTER reminder via the lookup filter", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await SNOOZE(snoozeRequest({ until: "2026-09-01" }), params());
    expect(res.status).toBe(404);
    const where = findFirstMock.mock.calls[0][0].where;
    expect(where.origin).toEqual({ not: "ENCOUNTER" });
  });

  it("snoozes a SCREENING reminder without a 409", async () => {
    findFirstMock.mockResolvedValue({
      ...BASE_ROW,
      measurementType: "GAD7_SCORE",
    });
    const res = await SNOOZE(snoozeRequest({ until: "2026-09-01" }), params());
    expect(res.status).toBe(200);
  });

  it("resolves the named day to the notifyHour in the profile timezone and moves both cursors together", async () => {
    const res = await SNOOZE(snoozeRequest({ until: "2026-09-01" }), params());
    expect(res.status).toBe(200);
    const { data } = updateMock.mock.calls[0][0];
    // 2026-09-01 09:00 Europe/Berlin (CEST, UTC+2) = 07:00Z. This is the
    // DST-aware wall-clock resolution, not a request-time offset.
    const expected = new Date("2026-09-01T07:00:00.000Z");
    expect(data.snoozedUntil).toEqual(expected);
    expect(data.nextDueAt).toEqual(expected);
    // The cadence and its cursors stay untouched.
    expect("lastSatisfiedAt" in data).toBe(false);
    expect("lastSkippedAt" in data).toBe(false);
    expect("intervalDays" in data).toBe(false);
    expect("anchorDate" in data).toBe(false);
  });

  it("422s a past or same-day date", async () => {
    const res = await SNOOZE(snoozeRequest({ until: "2026-06-15" }), params());
    expect(res.status).toBe(422);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("422s a date beyond the five-year cap", async () => {
    const res = await SNOOZE(snoozeRequest({ until: "2031-07-01" }), params());
    expect(res.status).toBe(422);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("422s a malformed body through the multi-issue envelope", async () => {
    const res = await SNOOZE(snoozeRequest({ until: "not-a-date" }), params());
    expect(res.status).toBe(422);
  });
});

describe("GET /api/measurement-reminders/[id]/history", () => {
  it("404s an ENCOUNTER reminder via the lookup filter", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await HISTORY(historyRequest(), params());
    expect(res.status).toBe(404);
    const where = findFirstMock.mock.calls[0][0].where;
    expect(where.origin).toEqual({ not: "ENCOUNTER" });
  });

  it("pages the ledger newest first with the meta triple", async () => {
    eventFindManyMock.mockResolvedValue([
      {
        id: "e2",
        kind: "SKIPPED",
        occurredAt: new Date("2026-06-10T09:00:00Z"),
        onTime: false,
        source: "skip",
        createdAt: new Date("2026-06-10T09:00:00Z"),
      },
      {
        id: "e1",
        kind: "SATISFIED",
        occurredAt: new Date("2026-05-10T09:00:00Z"),
        onTime: true,
        source: "manual",
        createdAt: new Date("2026-05-10T09:00:00Z"),
      },
    ]);
    eventCountMock.mockResolvedValue(2);

    const res = await HISTORY(historyRequest("?limit=10&offset=0"), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.events).toHaveLength(2);
    expect(body.data.events[0]).toMatchObject({
      id: "e2",
      kind: "SKIPPED",
      onTime: false,
      source: "skip",
    });
    expect(body.data.meta).toEqual({ total: 2, limit: 10, offset: 0 });
    const query = eventFindManyMock.mock.calls[0][0];
    // The trailing `id` is the unique tiebreaker: several reminder events
    // can share one `occurredAt`, and offset paging over a tied key repeats
    // and drops rows between pages.
    expect(query.orderBy).toEqual([{ occurredAt: "desc" }, { id: "desc" }]);
    expect(query.where).toEqual({ reminderId: "r1", userId: "u1" });
  });

  it("422s an out-of-range limit", async () => {
    const res = await HISTORY(historyRequest("?limit=1000"), params());
    expect(res.status).toBe(422);
  });
});
