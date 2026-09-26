/**
 * An open check-up stays due after its reminder, against real Postgres.
 *
 * Two halves.
 *
 *   1. **The whole loop, end to end.** A yearly check-up due today goes
 *      through the real reminder tick (real claim ledger, stubbed channel):
 *      it is reminded once, keeps its due date, shows on the start page's
 *      digest, is not reminded again the same day or the next, is reminded
 *      once more seven days on, and moves to next year when it is marked done.
 *   2. **Migration 0355's repair.** The container has every migration applied
 *      already, so the data steps are pulled out of the `.sql` file and run
 *      again against rows seeded the way an upgrading instance holds them:
 *      check-ups the old tick rolled on after a send go back to the reminded
 *      slot, and every row whose evidence is ambiguous is left alone. The
 *      steps run twice; the second run must change nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { runMeasurementReminderTick } from "@/lib/jobs/measurement-reminder";
import { satisfyReminder } from "@/lib/measurement-reminders/satisfy";
import { loadDailyDigest } from "@/lib/daily/load-digest";
import type { DispatchOutcome } from "@/lib/notifications/dispatcher";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const MIGRATION = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "0355_checkup_stays_due",
    "migration.sql",
  ),
  "utf8",
);

/** The migration's data statements (the repair and the hero-kind append). */
function dataSteps(): string[] {
  const sql = MIGRATION.split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const steps = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => /^(WITH|UPDATE)\b/i.test(statement));
  // Both data steps are the point; a matcher that finds fewer is a failure.
  expect(steps.length).toBe(2);
  return steps;
}

async function runDataSteps(): Promise<void> {
  const prisma = getPrismaClient();
  for (const step of dataSteps()) await prisma.$executeRawUnsafe(step);
}

const OK: DispatchOutcome = {
  dispatched: true,
  channelsAttempted: 1,
  channelsSucceeded: 1,
};

const TZ = "Europe/Berlin";
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
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
      ...extra,
    },
  });
}

describe("an open check-up through the reminder tick", () => {
  // 09:00 in Berlin.
  const DUE = new Date("2026-09-26T07:00:00.000Z");

  it("stays due, shows on the digest, repeats weekly, and moves on when done", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("checkup-owner");
    const created = await prisma.measurementReminder.create({
      data: {
        userId: user.id,
        label: "Skin check",
        measurementType: null,
        intervalDays: null,
        rrule: "FREQ=YEARLY;INTERVAL=1",
        notifyHour: 9,
        origin: "VORSORGE",
        enabled: true,
        lastSatisfiedAt: new Date("2025-09-26T07:00:00.000Z"),
        nextDueAt: DUE,
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    });
    const dispatch = vi.fn(async () => OK);
    const tick = (at: Date) =>
      runMeasurementReminderTick(prisma, at, { dispatch });

    // The due day's notify hour: reminded once, still due.
    const first = await tick(DUE);
    expect(first.dispatched).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    let row = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.nextDueAt).toEqual(DUE);
    expect(row.lastNotifiedAt).toEqual(DUE);
    expect(row.lastSatisfiedAt).toEqual(new Date("2025-09-26T07:00:00.000Z"));
    const events = await prisma.notificationEvent.findMany({
      where: { recordUserId: user.id },
    });
    expect(events.map((e) => e.dedupKey)).toEqual([
      `measurement:${created.id}:2026-09-26`,
    ]);

    // The start page names it, in the afternoon as much as in the morning.
    const fullUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const digest = await loadDailyDigest(
      fullUser,
      new Date(DUE.getTime() + 6 * 60 * 60 * 1000),
      { locale: "en" },
    );
    const care = digest.worthALook.find((i) => i.kind === "preventive_care");
    expect(care?.body).toContain("Skin check");

    // Fifteen minutes later, the same hour: not again.
    await tick(new Date(DUE.getTime() + 15 * 60 * 1000));
    // The next day at the notify hour: not again either.
    const nextDay = await tick(new Date(DUE.getTime() + DAY));
    expect(nextDay.skippedRepeatHeld).toBe(1);
    // Six days on: still held.
    await tick(new Date(DUE.getTime() + 6 * DAY));
    expect(dispatch).toHaveBeenCalledTimes(1);

    // Seven days on: reminded once more, and only once.
    const week = new Date(DUE.getTime() + 7 * DAY);
    await tick(week);
    await tick(new Date(week.getTime() + 15 * 60 * 1000));
    expect(dispatch).toHaveBeenCalledTimes(2);
    row = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.nextDueAt).toEqual(DUE);
    expect(row.lastNotifiedAt).toEqual(week);

    // Done: the next cycle is next year, counted from the completion.
    const doneAt = new Date(week.getTime() + 60 * 60 * 1000);
    const done = await satisfyReminder(prisma, row, TZ, doneAt, "manual");
    expect(done.satisfied).toBe(true);
    row = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.nextDueAt?.getUTCFullYear()).toBe(2027);
    await tick(new Date(week.getTime() + DAY));
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe("migration 0355", () => {
  it("adds the nullable last_notified_at column", async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<
      Array<{ is_nullable: string; data_type: string }>
    >(
      `SELECT is_nullable, data_type
         FROM information_schema.columns
        WHERE table_name = 'measurement_reminders'
          AND column_name = 'last_notified_at'`,
    );
    expect(rows).toEqual([
      { is_nullable: "YES", data_type: "timestamp without time zone" },
    ]);
  });

  // The instant the old tick claimed and delivered the reminder, and the
  // roll-on write a few seconds behind it.
  const SENT = new Date("2026-09-26T07:00:03.000Z");
  const ROLLED = new Date("2026-09-26T07:00:05.000Z");
  const NEXT_YEAR = new Date("2027-09-26T07:00:00.000Z");

  interface Case {
    id: string;
    data?: Partial<Prisma.MeasurementReminderUncheckedCreateInput>;
    /** When the row was last written; defaults to the roll-on. */
    updatedAt?: Date;
    /** Claim instants for this row; defaults to the one send. */
    claims?: Date[];
  }

  async function seedCase(userId: string, c: Case) {
    const prisma = getPrismaClient();
    await prisma.measurementReminder.create({
      data: {
        id: c.id,
        userId,
        label: c.id,
        measurementType: null,
        rrule: "FREQ=YEARLY;INTERVAL=1",
        notifyHour: 9,
        origin: "VORSORGE",
        enabled: true,
        nextDueAt: NEXT_YEAR,
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        ...c.data,
      },
    });
    await prisma.$executeRaw`
      UPDATE "measurement_reminders"
         SET "updated_at" = ${c.updatedAt ?? ROLLED}
       WHERE "id" = ${c.id}`;
    for (const at of c.claims ?? [SENT]) {
      await prisma.notificationEvent.create({
        data: {
          recordUserId: userId,
          eventType: "MEASUREMENT_REMINDER",
          dedupKey: `measurement:${c.id}:${at.toISOString().slice(0, 10)}`,
          createdAt: at,
        },
      });
    }
  }

  it("puts rolled-on check-ups back on the reminded slot and leaves everything ambiguous", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("migration-owner");

    const repaired: Case[] = [
      { id: "yearly-checkup" },
      { id: "coach-checkup", data: { origin: "COACH" } },
      {
        // A one-shot check-up the old tick rolled to nothing.
        id: "one-shot",
        data: { rrule: null, intervalDays: null, nextDueAt: null },
      },
      {
        // An earlier cycle's send is older; the latest send decides.
        id: "monthly-many-sends",
        data: {
          rrule: "FREQ=MONTHLY;INTERVAL=1",
          nextDueAt: new Date("2026-10-26T07:00:00.000Z"),
        },
        claims: [new Date("2026-08-26T07:00:03.000Z"), SENT],
      },
    ];
    const untouched: Case[] = [
      {
        id: "done-after-send",
        data: { lastSatisfiedAt: new Date("2026-09-26T10:00:00.000Z") },
        updatedAt: new Date("2026-09-26T10:00:00.000Z"),
      },
      {
        id: "skipped-after-send",
        data: { lastSkippedAt: new Date("2026-09-26T07:02:00.000Z") },
        updatedAt: new Date("2026-09-26T07:02:00.000Z"),
      },
      {
        // Snoozed a minute after the send to a day well past a week out, so
        // only the snooze cursor tells it apart from a roll-on.
        id: "snoozed",
        data: {
          snoozedUntil: new Date("2026-11-02T08:00:00.000Z"),
          nextDueAt: new Date("2026-11-02T08:00:00.000Z"),
        },
        updatedAt: new Date("2026-09-26T07:01:00.000Z"),
      },
      {
        // Edited two days after the send: the last write is not the roll-on.
        id: "edited-later",
        updatedAt: new Date("2026-09-28T12:00:00.000Z"),
      },
      {
        // A Telegram "later" pressed a minute after the send.
        id: "telegram-later",
        data: { nextDueAt: new Date("2026-09-26T10:01:00.000Z") },
        updatedAt: new Date("2026-09-26T07:01:00.000Z"),
      },
      {
        // A weekly check-up still rolls on under the new tick.
        id: "weekly",
        data: {
          rrule: null,
          intervalDays: 7,
          nextDueAt: new Date("2026-10-03T07:00:00.000Z"),
        },
      },
      { id: "measurement", data: { measurementType: "WEIGHT" } },
      { id: "appointment", data: { origin: "ENCOUNTER", rrule: null } },
      { id: "deleted", data: { deletedAt: ROLLED } },
      { id: "disabled", data: { enabled: false } },
      { id: "never-sent", claims: [] },
      {
        // The last send found no channel: nothing was rolled on.
        id: "no-channel",
        data: { nextDueAt: new Date("2026-09-25T07:00:00.000Z") },
      },
    ];

    for (const c of [...repaired, ...untouched]) await seedCase(user.id, c);
    const before = new Map(
      (await prisma.measurementReminder.findMany()).map((r) => [r.id, r]),
    );

    await runDataSteps();
    const afterFirst = await prisma.measurementReminder.findMany();
    await runDataSteps();
    const afterSecond = await prisma.measurementReminder.findMany();

    const byId = new Map(afterFirst.map((r) => [r.id, r]));
    for (const c of repaired) {
      expect(byId.get(c.id)?.nextDueAt, c.id).toEqual(SENT);
      expect(byId.get(c.id)?.lastNotifiedAt, c.id).toEqual(SENT);
    }
    for (const c of untouched) {
      const was = before.get(c.id)!;
      const now = byId.get(c.id)!;
      expect(now.nextDueAt, c.id).toEqual(was.nextDueAt);
      expect(now.lastNotifiedAt, c.id).toBeNull();
    }
    // Nothing deleted, and the second run is a no-op.
    expect(afterFirst).toHaveLength(repaired.length + untouched.length);
    const key = (rows: typeof afterFirst) =>
      rows
        .map(
          (r) =>
            `${r.id}|${r.nextDueAt?.toISOString()}|${r.lastNotifiedAt?.toISOString()}`,
        )
        .sort();
    expect(key(afterSecond)).toEqual(key(afterFirst));
  });

  it("adds visits to a stored start-page choice that predates them, and only there", async () => {
    const prisma = getPrismaClient();
    const legacy = ["dose_window", "preventive_care", "sync_issue"];
    await seedUser("hero-legacy", {
      dashboardWidgetsJson: { version: 1, enabledHeroItemKinds: legacy },
    });
    await seedUser("hero-off", {
      dashboardWidgetsJson: { version: 1, enabledHeroItemKinds: [] },
    });
    await seedUser("hero-has-visits", {
      dashboardWidgetsJson: {
        version: 1,
        enabledHeroItemKinds: ["upcoming_visit"],
      },
    });
    await seedUser("hero-default", {
      dashboardWidgetsJson: { version: 1, widgets: [] },
    });
    await seedUser("hero-none");

    await runDataSteps();
    await runDataSteps();

    const layout = async (id: string) =>
      (await prisma.user.findUniqueOrThrow({ where: { id } }))
        .dashboardWidgetsJson as Record<string, unknown> | null;
    expect((await layout("hero-legacy"))?.enabledHeroItemKinds).toEqual([
      ...legacy,
      "upcoming_visit",
    ]);
    expect((await layout("hero-off"))?.enabledHeroItemKinds).toEqual([]);
    expect((await layout("hero-has-visits"))?.enabledHeroItemKinds).toEqual([
      "upcoming_visit",
    ]);
    expect(await layout("hero-default")).toEqual({ version: 1, widgets: [] });
    expect(await layout("hero-none")).toBeNull();
  });
});
