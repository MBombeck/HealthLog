/**
 * `GET /api/medications/{id}/cadence` — the expected-vs-actual dose timeline
 * and the four compliance chips, computed from the stored intake events,
 * against the real database and through the real API kit.
 *
 * Pinned here:
 *   - the timeline and the chips are computed from the record's own stored
 *     doses: a daily dose taken on every past day but one shows that day as
 *     the single miss, the streak since it, and the matching adherence;
 *   - a tombstoned dose counts as not taken;
 *   - the window defaults to 30 days, honours `days`, and refuses a value
 *     outside 1..180 (or not a number) with the multi-issue 422;
 *   - a medication with no schedule has no next dose; one with a daily
 *     schedule has one;
 *   - another account's medication is 404 and an anonymous caller 401.
 *
 * "Now" is the wall clock: every dose is seeded relative to it, and today's
 * slot is either seeded as taken (its window has opened) or still upcoming,
 * so neither state can turn into a miss on any day the suite runs.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/medications/[id]/cadence/route";

import { anonymous, callRoute } from "../../kit/call-route";
import { makeMedication, makeSession, makeUser } from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";
import { expectSanitisedIssue } from "../zod-issue-shape";

const prisma = getPrismaClient();
const ROUTE = "/api/medications/{id}/cadence";
const DAY_MS = 24 * 60 * 60 * 1000;

interface CadenceBody {
  windowDays: number;
  anchorIso: string;
  next: {
    windowStart: string;
    windowEnd: string;
    scheduleIndex: number;
  } | null;
  chips: {
    adherenceRate: number | null;
    currentStreak: number;
    longestStreak: number;
    missedLast30: number;
    windowDays: number;
  };
  timeline: Array<{
    day: string;
    windowStart: string;
    windowEnd: string;
    scheduleIndex: number;
    status: "taken" | "skipped" | "missed" | "upcoming";
  }>;
}

interface ValidationBody {
  details: { issues: Array<Record<string, unknown>> };
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

/** 08:00 UTC on the day `daysAgo` before today. */
function slotStart(daysAgo: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - daysAgo,
      8,
      0,
      0,
    ),
  );
}

/**
 * A daily 08:00–10:00 medication created 40 days ago, taken half an hour
 * into the window on every day of the last `days` except `missedDaysAgo`.
 * Today's dose is recorded only once its take time has passed.
 */
async function dailyMedicationWithOneMiss(options: {
  days: number;
  missedDaysAgo: number;
}) {
  const owner = await makeUser({ timezone: "UTC" });
  const med = await makeMedication(owner, {
    createdAt: new Date(Date.now() - 40 * DAY_MS),
  });
  const takes: Date[] = [];
  for (let daysAgo = options.days; daysAgo >= 0; daysAgo--) {
    if (daysAgo === options.missedDaysAgo) continue;
    const takenAt = new Date(slotStart(daysAgo).getTime() + 30 * 60 * 1000);
    if (takenAt.getTime() > Date.now()) continue;
    takes.push(takenAt);
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: owner.id,
        medicationId: med.id,
        scheduledFor: slotStart(daysAgo),
        takenAt,
      },
    });
  }
  return { owner, med, takes };
}

function pastDays(body: CadenceBody) {
  const today = slotStart(0).toISOString().slice(0, 10);
  return body.timeline.filter((p) => p.windowStart.slice(0, 10) < today);
}

describe("GET /api/medications/{id}/cadence", () => {
  it("computes the timeline and the chips from the stored doses", async () => {
    const { owner, med } = await dailyMedicationWithOneMiss({
      days: 20,
      missedDaysAgo: 3,
    });

    const res = await callRoute<CadenceBody>(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: med.id },
      query: { days: 14 },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(200);
    expect(res.data.windowDays).toBe(14);
    expect(res.data.anchorIso).toBe(med.createdAt.toISOString());

    const past = pastDays(res.data);
    expect(past.length).toBeGreaterThanOrEqual(13);
    const missed = past.filter((p) => p.status === "missed");
    expect(missed.map((p) => p.windowStart)).toEqual([
      slotStart(3).toISOString(),
    ]);
    expect(
      past
        .filter((p) => p.status !== "missed")
        .every((p) => p.status === "taken"),
    ).toBe(true);
    // Today's slot appears once its window has opened, and is then taken or
    // still upcoming, never a miss.
    const today = res.data.timeline.filter(
      (p) => p.windowStart >= slotStart(0).toISOString(),
    );
    expect(today.every((p) => p.status !== "missed")).toBe(true);

    // One miss three days ago: the run since covers two past days and today.
    expect(res.data.chips.missedLast30).toBe(1);
    expect(res.data.chips.currentStreak).toBe(3);
    const taken = res.data.timeline.filter((p) => p.status === "taken").length;
    expect(res.data.chips.adherenceRate).toBe(
      Math.round((taken / (taken + 1)) * 100),
    );
    expect(res.data.next).not.toBeNull();
  });

  it("counts a tombstoned dose as not taken", async () => {
    const { owner, med } = await dailyMedicationWithOneMiss({
      days: 20,
      missedDaysAgo: 3,
    });
    await prisma.medicationIntakeEvent.updateMany({
      where: { medicationId: med.id, scheduledFor: slotStart(5) },
      data: { deletedAt: new Date() },
    });

    const res = await callRoute<CadenceBody>(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: med.id },
      query: { days: 14 },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(200);
    expect(
      pastDays(res.data)
        .filter((p) => p.status === "missed")
        .map((p) => p.windowStart),
    ).toEqual([slotStart(5).toISOString(), slotStart(3).toISOString()]);
    expect(res.data.chips.missedLast30).toBe(2);
  });

  it("defaults to a 30-day window and has no next dose without a schedule", async () => {
    const owner = await makeUser({ timezone: "UTC" });
    const med = await makeMedication(
      owner,
      { createdAt: new Date(Date.now() - 60 * DAY_MS) },
      [],
    );

    const res = await callRoute<CadenceBody>(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: med.id },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(200);
    expect(res.data.windowDays).toBe(30);
    expect(res.data.next).toBeNull();
    expect(res.data.timeline).toEqual([]);
    expect(res.data.chips.adherenceRate).toBeNull();
  });

  it.each([
    ["9999", "too large", { code: "too_big", maximum: 180 }],
    ["0", "below one", { code: "too_small", minimum: 1 }],
    ["notanumber", "not a number", { code: "invalid_type" }],
  ])(
    "refuses days=%s (%s) with the multi-issue 422",
    async (days, _, named) => {
      const owner = await makeUser();
      const med = await makeMedication(owner);

      const res = await callRoute(GET, {
        method: "GET",
        route: ROUTE,
        params: { id: med.id },
        query: { days },
        auth: await makeSession(owner),
      });

      expect(res.status).toBe(422);
      expect(res.error).toBe("Validation failed");
      const issues = (res.body as ValidationBody).details.issues;
      expect(issues.length).toBeGreaterThanOrEqual(1);
      expect(issues.every((i) => i.path === "days")).toBe(true);
      for (const issue of issues) expectSanitisedIssue(issue);
      // A bound issue names the declared bound, never the value sent.
      expect(issues[0]).toMatchObject(named);
    },
  );

  it("answers 404 for another account's medication", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const theirs = await makeMedication(other);

    const res = await callRoute(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: theirs.id },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(404);
  });

  it("answers 401 to an anonymous caller", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);

    const res = await callRoute(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: med.id },
      auth: anonymous,
    });

    expect(res.status).toBe(401);
  });
});
