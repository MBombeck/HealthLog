/**
 * v1.32.1 — regression for iOS coordination issue #62: the `nextDueAt`
 * recomputation on `PATCH /api/measurement-reminders/{id}` used to read an
 * explicit `null` cadence clear as "field omitted" (`?? existing.field`
 * cannot distinguish the two — both are nullish) and recompute against the
 * STALE cadence for one cycle, even though the persisted row itself already
 * carried the correct cleared value.
 *
 * Every test below drives the REAL `computeReminderNextDueAt` (not a mock)
 * so the "correct" and "stale" comparison values are genuine recurrence-
 * engine output, not hand-picked dates — and asserts the fixtures actually
 * differ before trusting the route's answer, so a fixture collision can't
 * hide a regression.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1", locale: "en" } })),
  // v1.37.0 — the mutating arms resolve the RECORD at MANAGE. `actor` is the
  // caller and equals `user` for everyone acting on their own reminders,
  // which is what this suite exercises.
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
const findUserMock = vi.fn();
const auditLogCreateMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    measurementReminder: {
      findFirst: (...a: unknown[]) => findFirstMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
    },
    user: { findUnique: (...a: unknown[]) => findUserMock(...a) },
    auditLog: { create: (...a: unknown[]) => auditLogCreateMock(...a) },
  },
}));

import { PATCH } from "../route";
import { computeReminderNextDueAt } from "@/lib/measurement-reminders/scheduling";

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
  nextDueAt: new Date("2026-01-31T09:00:00Z"),
  lastSatisfiedAt: null as Date | null,
  lastNotifiedAt: null as Date | null,
  snoozedUntil: null as Date | null,
  enabled: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  deletedAt: null,
};

const NOW = new Date("2026-06-15T08:00:00.000Z");
const TZ = "Europe/Berlin";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurement-reminders/r1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "r1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  findUserMock.mockResolvedValue({ timezone: TZ });
  updateMock.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      ...BASE_ROW,
      ...data,
    }),
  );
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PATCH /api/measurement-reminders/[id] — nextDueAt honours explicit-null cadence clears (regression iOS #62)", () => {
  it("interval → RRULE: recomputes off the NEW rrule, not the just-cleared interval", async () => {
    // Existing rolling reminder: intervalDays=30, rrule=null.
    findFirstMock.mockResolvedValue(BASE_ROW);

    const res = await PATCH(
      makeRequest({ intervalDays: null, rrule: "FREQ=YEARLY" }),
      params,
    );
    expect(res.status).toBe(200);

    const persisted = updateMock.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    // The explicit-null clear + the new rrule both persist correctly —
    // this half was never broken.
    expect(persisted.intervalDays).toBeNull();
    expect(persisted.rrule).toBe("FREQ=YEARLY");

    const correct = computeReminderNextDueAt(
      { ...BASE_ROW, intervalDays: null, rrule: "FREQ=YEARLY" },
      TZ,
      NOW,
    );
    // The bug: `?? existing` reads the cleared intervalDays as "omitted"
    // and recomputes against the OLD rolling cadence for one cycle.
    const staleBug = computeReminderNextDueAt(
      { ...BASE_ROW, intervalDays: 30, rrule: null },
      TZ,
      NOW,
    );
    // Mutation-check guard: the fixtures must actually diverge, or this
    // test can't tell a fix from a no-op.
    expect(correct).not.toEqual(staleBug);

    expect(persisted.nextDueAt).toEqual(correct);
    expect(persisted.nextDueAt).not.toEqual(staleBug);
  });

  it("RRULE → interval: recomputes off the NEW interval, not the just-cleared rrule (incl. its BYHOUR)", async () => {
    findFirstMock.mockResolvedValue({
      ...BASE_ROW,
      intervalDays: null,
      rrule: "FREQ=DAILY;BYHOUR=7,19",
    });

    const res = await PATCH(
      makeRequest({ rrule: null, intervalDays: 14 }),
      params,
    );
    expect(res.status).toBe(200);

    const persisted = updateMock.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(persisted.rrule).toBeNull();
    expect(persisted.intervalDays).toBe(14);

    const correct = computeReminderNextDueAt(
      { ...BASE_ROW, intervalDays: 14, rrule: null },
      TZ,
      NOW,
    );
    const staleBug = computeReminderNextDueAt(
      { ...BASE_ROW, intervalDays: null, rrule: "FREQ=DAILY;BYHOUR=7,19" },
      TZ,
      NOW,
    );
    expect(correct).not.toEqual(staleBug);

    expect(persisted.nextDueAt).toEqual(correct);
    expect(persisted.nextDueAt).not.toEqual(staleBug);
  });

  it("explicit anchorDate: null clear recomputes off no-anchor, not the stale anchor", async () => {
    findFirstMock.mockResolvedValue({
      ...BASE_ROW,
      intervalDays: 30,
      anchorDate: new Date("2026-01-15T00:00:00Z"),
    });

    const res = await PATCH(makeRequest({ anchorDate: null }), params);
    expect(res.status).toBe(200);

    const persisted = updateMock.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(persisted.anchorDate).toBeNull();

    const correct = computeReminderNextDueAt(
      { ...BASE_ROW, intervalDays: 30, anchorDate: null },
      TZ,
      NOW,
    );
    const staleBug = computeReminderNextDueAt(
      {
        ...BASE_ROW,
        intervalDays: 30,
        anchorDate: new Date("2026-01-15T00:00:00Z"),
      },
      TZ,
      NOW,
    );
    expect(correct).not.toEqual(staleBug);

    expect(persisted.nextDueAt).toEqual(correct);
    expect(persisted.nextDueAt).not.toEqual(staleBug);
  });

  it("omitted cadence fields on a label-only edit leave the cadence — and nextDueAt — unchanged", async () => {
    findFirstMock.mockResolvedValue(BASE_ROW);

    const res = await PATCH(makeRequest({ label: "New label" }), params);
    expect(res.status).toBe(200);

    const persisted = updateMock.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(persisted.label).toBe("New label");
    // The cadence keys are never written at all on a label-only edit — no
    // clear, no touch.
    expect("intervalDays" in persisted).toBe(false);
    expect("rrule" in persisted).toBe(false);
    expect("anchorDate" in persisted).toBe(false);

    // v1.39.2 — and nextDueAt is not written either. It used to be
    // recomputed on every PATCH, so correcting the label of an open,
    // overdue check-up (BASE_ROW is due 2026-01-31, NOW is June) quietly
    // moved it to its next slot, the same "reminded and gone" defect the
    // reminder tick had. Only a change to when it recurs reschedules it.
    expect("nextDueAt" in persisted).toBe(false);
    expect("snoozedUntil" in persisted).toBe(false);
  });

  it("an edit that resends the unchanged cadence keeps an overdue slot", async () => {
    findFirstMock.mockResolvedValue(BASE_ROW);

    const res = await PATCH(
      makeRequest({ label: "New label", intervalDays: 30, rrule: null }),
      params,
    );
    expect(res.status).toBe(200);

    const persisted = updateMock.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect("nextDueAt" in persisted).toBe(false);
  });

  it("a notify-hour edit keeps the due day and moves only the hour", async () => {
    findFirstMock.mockResolvedValue(BASE_ROW);

    const res = await PATCH(makeRequest({ notifyHour: 18 }), params);
    expect(res.status).toBe(200);

    const persisted = updateMock.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    // 2026-01-31 18:00 in Berlin (UTC+1 in winter).
    expect(persisted.nextDueAt).toEqual(new Date("2026-01-31T17:00:00Z"));
  });

  it("re-enabling a disabled short-cycle reminder schedules it from now", async () => {
    const weekly = { ...BASE_ROW, intervalDays: 7, enabled: false };
    findFirstMock.mockResolvedValue(weekly);

    const res = await PATCH(makeRequest({ enabled: true }), params);
    expect(res.status).toBe(200);

    const persisted = updateMock.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    const expected = computeReminderNextDueAt(weekly, TZ, NOW);
    expect(persisted.nextDueAt).toEqual(expected);
  });

  it("re-enabling an overdue reminder that stays due keeps its open slot", async () => {
    // Thirty-day cycle, due in January: switching it off and on again is not
    // doing it.
    findFirstMock.mockResolvedValue({ ...BASE_ROW, enabled: false });

    const res = await PATCH(makeRequest({ enabled: true }), params);
    expect(res.status).toBe(200);

    const persisted = updateMock.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(persisted.enabled).toBe(true);
    expect("nextDueAt" in persisted).toBe(false);
  });

  it("reads a resent first due date on the same calendar day as unchanged", async () => {
    // A booster row stores the dose instant plus N days; the web form sends
    // the same day back as local midnight. Same day in the profile zone, so
    // neither the anchor nor the due date moves.
    findFirstMock.mockResolvedValue({
      ...BASE_ROW,
      anchorDate: new Date("2026-01-10T13:37:00Z"),
    });

    const res = await PATCH(
      makeRequest({
        label: "New label",
        anchorDate: "2026-01-09T23:00:00.000Z", // 00:00 on the 10th, Berlin
      }),
      params,
    );
    expect(res.status).toBe(200);

    const persisted = updateMock.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect("anchorDate" in persisted).toBe(false);
    expect("nextDueAt" in persisted).toBe(false);
  });

  it("moves the last-sent cursor with a later notify hour on the day it was sent", async () => {
    // Sent at 09:00 today, moved to 18:00: still the slot that was sent, so
    // the tick must not send it again at 18:00.
    findFirstMock.mockResolvedValue({
      ...BASE_ROW,
      nextDueAt: new Date("2026-06-15T07:00:00Z"),
      lastNotifiedAt: new Date("2026-06-15T07:00:05Z"),
    });

    const res = await PATCH(makeRequest({ notifyHour: 18 }), params);
    expect(res.status).toBe(200);

    const persisted = updateMock.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(persisted.nextDueAt).toEqual(new Date("2026-06-15T16:00:00Z"));
    expect(persisted.lastNotifiedAt).toEqual(new Date("2026-06-15T16:00:00Z"));
  });
});
