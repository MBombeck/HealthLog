/**
 * The Today overview on the daily digest, against real Postgres.
 *
 * The unit suites pin the selection rules on hand-built inputs. This one runs
 * the whole read path (the dashboard snapshot, the coincident-deviation
 * engine, the visit and episode tables, the cycle grid, the stored daily
 * scores) on seeded rows, and checks that what comes out is a valid
 * `DailyDigest` under the published OpenAPI schema. An account without any
 * AI provider is the subject on purpose: the overview has to be whole
 * without one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { loadDailyDigest } from "@/lib/daily/load-digest";
import { dailyDigestResponse } from "@/lib/openapi/routes/daily";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const TZ = "Europe/Berlin";
const DAY = 24 * 60 * 60 * 1000;
// 08:00 in Berlin on a Sunday morning.
const NOW = new Date("2026-10-04T06:00:00.000Z");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  __resetAllCachesForTests();
});

async function seedUser(
  id: string,
  extra: Partial<Prisma.UserCreateInput> = {},
) {
  return getPrismaClient().user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      timezone: TZ,
      gender: "FEMALE",
      dateOfBirth: new Date("1985-05-05T00:00:00.000Z"),
      ...extra,
    },
  });
}

/** A month of steady resting heart rate and HRV, then an elevated morning. */
async function seedVitals(userId: string) {
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  for (let d = 30; d >= 1; d--) {
    const at = new Date(NOW.getTime() - d * DAY);
    rows.push(
      {
        userId,
        type: "RESTING_HEART_RATE",
        value: 52 + (d % 3),
        unit: "bpm",
        measuredAt: at,
        source: "MANUAL",
      },
      {
        userId,
        type: "HEART_RATE_VARIABILITY",
        value: 48 + (d % 4),
        unit: "ms",
        measuredAt: at,
        source: "MANUAL",
      },
    );
  }
  rows.push(
    {
      userId,
      type: "RESTING_HEART_RATE",
      value: 66,
      unit: "bpm",
      measuredAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      source: "MANUAL",
    },
    {
      userId,
      type: "HEART_RATE_VARIABILITY",
      value: 49,
      unit: "ms",
      measuredAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      source: "MANUAL",
    },
  );
  await getPrismaClient().measurement.createMany({ data: rows });
}

async function seedDay(userId: string, cycleTrackingEnabled?: boolean) {
  const prisma = getPrismaClient();
  await seedVitals(userId);
  // Unwell since Friday evening, Berlin time: day 3 on Sunday.
  await prisma.illnessEpisode.create({
    data: {
      userId,
      label: "Cold",
      type: "INFECTION",
      onsetAt: new Date("2026-10-02T18:00:00.000Z"),
    },
  });
  // Tomorrow 09:30 in Berlin.
  await prisma.encounter.create({
    data: {
      userId,
      occurredAt: new Date("2026-10-05T07:30:00.000Z"),
      status: "PLANNED",
      kind: "ROUTINE",
    },
  });
  // One logged period starting eleven days ago: day 12 today, phase still
  // withheld while the engine learns.
  await prisma.cycleProfile.create({ data: { userId, cycleTrackingEnabled } });
  await prisma.menstrualCycle.create({
    data: {
      userId,
      startDate: "2026-09-23",
      periodEndDate: "2026-09-27",
      tz: TZ,
    },
  });
}

describe("the Today overview on a real record", () => {
  it("publishes a valid digest with a deterministic lead and module-gated facts", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("today-owner");
    await seedDay(user.id);
    const full = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });

    const digest = await loadDailyDigest(full, NOW, { locale: "en" });

    // The published contract holds, new fields included.
    const parsed = dailyDigestResponse.safeParse(
      JSON.parse(JSON.stringify(digest)),
    );
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);

    // No AI provider: no briefing text, and the lead is built from the
    // morning's elevated resting heart rate.
    expect(digest.briefingLead).toBeNull();
    expect(digest.lead?.source).toBe("signal");
    expect(digest.lead?.text).toMatch(
      /^Resting heart rate is at 66 bpm, above your usual range of \d+ to \d+ bpm\.$/,
    );

    // Rest Mode passes through, counted on the Berlin calendar.
    expect(digest.restMode).toEqual({ day: 3 });

    // Tomorrow's visit is on the rail, so it is not repeated under Today;
    // the vitals line became the lead, so it is not repeated either.
    expect(digest.worthALook.some((i) => i.kind === "upcoming_visit")).toBe(
      true,
    );
    expect(digest.today.map((f) => f.kind)).toEqual(["rest_mode", "cycle"]);
    expect(digest.today[0].value).toBe("Day 3");
    expect(digest.today[1].value).toBe("Day 12");
  });

  it("names the visit under Today when the rail does not carry it", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("today-norail");
    await seedDay(user.id);
    const full = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });

    const digest = await loadDailyDigest(full, NOW, {
      locale: "en",
      enabledItemKinds: PRIORITY_ITEM_KINDS.filter(
        (kind) => kind !== "upcoming_visit",
      ),
    });
    const appointment = digest.today.find((f) => f.kind === "appointment");
    expect(appointment?.value).toBe("Tomorrow 09:30 AM, Routine visit");
  });

  it("says nothing about switched-off modules", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("today-modules-off", {
      modulePreferencesJson: { illness: false },
    });
    // The cycle module follows the cycle profile's own switch, not the
    // module preference blob.
    await seedDay(user.id, false);
    const full = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });

    const digest = await loadDailyDigest(full, NOW, { locale: "en" });
    expect(digest.restMode).toBeNull();
    expect(digest.today.some((f) => f.kind === "rest_mode")).toBe(false);
    expect(digest.today.some((f) => f.kind === "cycle")).toBe(false);
    expect(
      dailyDigestResponse.safeParse(JSON.parse(JSON.stringify(digest))).success,
    ).toBe(true);
  });

  it("stays valid and empty for an account with nothing recorded", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("today-empty");
    const full = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });

    const digest = await loadDailyDigest(full, NOW, { locale: "en" });
    expect(digest.lead).toBeNull();
    expect(digest.today).toEqual([]);
    expect(digest.restMode).toBeNull();
    expect(
      dailyDigestResponse.safeParse(JSON.parse(JSON.stringify(digest))).success,
    ).toBe(true);
  });
});
