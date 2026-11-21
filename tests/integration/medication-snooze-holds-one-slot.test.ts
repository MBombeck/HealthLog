/**
 * A snooze answers one dose, not the medication.
 *
 * `snoozedUntil` lives on the medication row. The reminder worker scopes it
 * to the slot that was open when it was set; the today list did not, so every
 * open slot of the medication read as snoozed. A Telegram skip made it worse:
 * it snoozed the whole medication to the end of the day, so the evening dose
 * read as snoozed on the phone while the worker reminded it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  DAY_MS,
  TZ,
  readToday,
  statusPost,
} from "./medication-dose-state-fixtures";
import { markMedicationSkipped } from "@/lib/telegram-dose-writes";

vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

// 10:10 in Berlin: the 10:00 dose is open, the 16:00 dose is not yet.
const NOW = new Date("2026-11-21T09:10:00.000Z");
const MORNING = new Date("2026-11-21T09:00:00.000Z");
const AFTERNOON = new Date("2026-11-21T15:00:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function twiceDaily() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "snooze",
      email: "snooze@example.test",
      role: "USER",
      timezone: TZ,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  const med = await prisma.medication.create({
    data: {
      userId: user.id,
      name: "Twice",
      dose: "1",
      active: true,
      startsOn: new Date(Date.now() - 30 * DAY_MS),
      createdAt: new Date(Date.now() - 30 * DAY_MS),
      schedules: {
        create: {
          windowStart: "10:00",
          windowEnd: "16:00",
          timesOfDay: ["10:00", "16:00"],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  return { user, medId: med.id };
}

function statusAt(rows: Awaited<ReturnType<typeof readToday>>, at: Date) {
  return rows
    .filter((r) => new Date(r.scheduledAt).getTime() === at.getTime())
    .map((r) => r.status);
}

describe("a snooze holds the dose it answers", () => {
  it("a snooze on the open dose leaves the later dose pending", async () => {
    const { medId } = await twiceDaily();
    const rows = await readToday();
    const morning = rows.find(
      (r) =>
        r.medicationId === medId &&
        new Date(r.scheduledAt).getTime() === MORNING.getTime(),
    );
    expect(morning).toBeDefined();
    const r = await statusPost({
      intakeId: morning!.id,
      status: "snoozed",
      snoozedUntil: new Date(NOW.getTime() + 8 * 3_600_000).toISOString(),
    });
    expect(r.status).toBe(200);

    const after = await readToday();
    expect(statusAt(after, MORNING)).toEqual(["snoozed"]);
    expect(statusAt(after, AFTERNOON)).toEqual(["pending"]);
    const afternoon = after.find(
      (x) => new Date(x.scheduledAt).getTime() === AFTERNOON.getTime(),
    );
    expect(afternoon?.snoozedUntil).toBeNull();
  });

  it("a Telegram skip of the morning dose does not snooze the afternoon dose", async () => {
    const { user, medId } = await twiceDaily();
    await readToday();
    await markMedicationSkipped({
      userId: user.id,
      userTz: TZ,
      medicationId: medId,
      chatId: "1",
      messageId: undefined,
    });
    const after = await readToday();
    expect(statusAt(after, MORNING)).toEqual(["skipped"]);
    expect(statusAt(after, AFTERNOON)).toEqual(["pending"]);
  });

  it("a snooze without an instant defers by the person's snooze length", async () => {
    const { user, medId } = await twiceDaily();
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: user.id },
      data: { notificationPrefs: { medication: { snoozeMinutes: 45 } } },
    });
    const morning = (await readToday()).find(
      (r) =>
        r.medicationId === medId &&
        new Date(r.scheduledAt).getTime() === MORNING.getTime(),
    );
    const r = await statusPost({ intakeId: morning!.id, status: "snoozed" });
    expect(r.status).toBe(200);
    const med = await prisma.medication.findUniqueOrThrow({
      where: { id: medId },
    });
    expect(med.snoozedUntil?.getTime()).toBe(NOW.getTime() + 45 * 60_000);
  });

  it("without a setting the snooze length is 30 minutes", async () => {
    const { medId } = await twiceDaily();
    const morning = (await readToday()).find(
      (r) =>
        r.medicationId === medId &&
        new Date(r.scheduledAt).getTime() === MORNING.getTime(),
    );
    await statusPost({ intakeId: morning!.id, status: "snoozed" });
    const med = await getPrismaClient().medication.findUniqueOrThrow({
      where: { id: medId },
    });
    expect(med.snoozedUntil?.getTime()).toBe(NOW.getTime() + 30 * 60_000);
  });
});
