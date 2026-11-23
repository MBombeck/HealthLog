/**
 * A decision that arrives for a slot somebody already took writes nothing.
 *
 * - A guardian tapping "Taken" on a dose the pill box already booked used to
 *   answer 201 with `alreadyTaken: false`, and the owner got a second
 *   confirmation and a guardian notice for a dose that was never written:
 *   the delegate branch ran before the already-taken check.
 * - A stale skip (an old Telegram reminder button, a queued web or bulk
 *   entry) used to overwrite the take, refund its stock and show the dose as
 *   skipped everywhere. It answers `alreadyTaken` now and keeps the take.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";
import { DAY_MS, TZ, perMedPost } from "./medication-dose-state-fixtures";

const syncCalls: unknown[] = [];
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: (arg: unknown) => syncCalls.push(arg),
}));
const notices: unknown[] = [];
vi.mock("@/lib/notifications/delegated-intake", () => ({
  notifyDelegatedIntake: async (arg: unknown) => {
    notices.push(arg);
  },
}));
vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

// 08:10 in Berlin; the dose is due at 08:00 and the pill box took it at 08:02.
const NOW = new Date("2026-11-21T07:10:00.000Z");
const SLOT = new Date("2026-11-21T07:00:00.000Z");
const BOX_AT = new Date("2026-11-21T07:02:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  syncCalls.length = 0;
  notices.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

let counter = 0;

async function makePerson(label: string) {
  const s = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: s,
      email: `${s}@example.test`,
      role: "USER",
      timezone: TZ,
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + DAY_MS) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

/** An owner whose 08:00 dose the pill box already took. */
async function takenByPillBox() {
  const prisma = getPrismaClient();
  const owner = await makePerson("owner");
  const med = await prisma.medication.create({
    data: {
      userId: owner.id,
      name: "Ramipril",
      dose: "5 mg",
      active: true,
      startsOn: new Date(Date.now() - 30 * DAY_MS),
      createdAt: new Date(Date.now() - 30 * DAY_MS),
      schedules: {
        create: {
          windowStart: "08:00",
          windowEnd: "08:00",
          timesOfDay: ["08:00"],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  const take = await prisma.medicationIntakeEvent.create({
    data: {
      userId: owner.id,
      medicationId: med.id,
      scheduledFor: SLOT,
      takenAt: BOX_AT,
      source: "API",
      takenVia: "INTEGRATION",
      idempotencyKey: "box-1",
    },
  });
  return { owner, medId: med.id, take };
}

async function expectTakeKept(medId: string, takeId: string) {
  const rows = await getPrismaClient().medicationIntakeEvent.findMany({
    where: { medicationId: medId, deletedAt: null },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: takeId,
    skipped: false,
    takenVia: "INTEGRATION",
    syncVersion: 0,
  });
  expect(rows[0].takenAt?.getTime()).toBe(BOX_AT.getTime());
}

describe("a decision for a slot that already holds a take", () => {
  it("answers a guardian's take with alreadyTaken, and tells nobody", async () => {
    const { owner, medId, take } = await takenByPillBox();
    const guardian = await makePerson("guardian");
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: guardian.id,
      access: "WRITE",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: guardian.id });
    const session = await signIn(guardian.id);
    await switchSessionTo(session.id, owner.id);

    const res = await perMedPost(medId, {
      scheduledFor: SLOT.toISOString(),
      idempotencyKey: "guardian-1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      id: take.id,
      alreadyTaken: true,
      takenVia: "INTEGRATION",
    });
    await expectTakeKept(medId, take.id);
    expect(notices).toHaveLength(0);
    expect(syncCalls).toHaveLength(0);
    expect(
      await getPrismaClient().auditLog.count({
        where: { userId: owner.id, action: "medication.intake" },
      }),
    ).toBe(0);
  });

  it("answers a stale web skip with alreadyTaken and keeps the take", async () => {
    const { owner, medId, take } = await takenByPillBox();
    await signIn(owner.id);
    const res = await perMedPost(medId, {
      skipped: true,
      scheduledFor: SLOT.toISOString(),
      idempotencyKey: "web-skip-1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ id: take.id, alreadyTaken: true });
    await expectTakeKept(medId, take.id);
    expect(syncCalls).toHaveLength(0);
  });

  it("answers a stale bulk skip with alreadyTaken", async () => {
    const { owner, medId, take } = await takenByPillBox();
    await signIn(owner.id);
    const { POST } = await import("@/app/api/medications/intake/bulk/route");
    const res = await (
      POST as unknown as (r: NextRequest) => Promise<Response>
    )(
      new NextRequest("http://localhost/api/medications/intake/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              medicationId: medId,
              scheduledFor: SLOT.toISOString(),
              skipped: true,
              idempotencyKey: "phone-skip-1",
            },
          ],
        }),
      }),
    );
    const body = (await res.json()) as {
      data: { entries: Array<Record<string, unknown>> };
    };
    expect(body.data.entries[0]).toMatchObject({
      status: "alreadyTaken",
      takenVia: "INTEGRATION",
    });
    await expectTakeKept(medId, take.id);
  });

  it("answers an old Telegram skip button with alreadyTaken", async () => {
    const { owner, medId, take } = await takenByPillBox();
    const { markMedicationSkipped } =
      await import("@/lib/telegram-dose-writes");
    const answer = await markMedicationSkipped({
      userId: owner.id,
      userTz: TZ,
      medicationId: medId,
      chatId: "chat-1",
      messageId: undefined,
    });
    expect(answer).toBe("alreadyTaken");
    await expectTakeKept(medId, take.id);
    expect(syncCalls).toHaveLength(0);
  });
});
