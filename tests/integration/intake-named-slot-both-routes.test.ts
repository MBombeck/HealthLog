/**
 * A take that names its slot binds the same way on both intake routes.
 *
 * The app sends the slot as `scheduledFor` on every write path, early takes
 * included, and posts either route: `POST /api/medications/{id}/intake` for a
 * tap, `POST /api/medications/intake/bulk` for the outbox. The single route
 * honoured a named slot behind the take; the bulk route bound by the band
 * alone. So the same take answered a slot on one route and an extra dose on
 * the other, and where two doses' windows overlap, the band gave the take to
 * the nearer anchor, not to the dose the person tapped (a 19:30 take of the
 * due 20:00 dose answered `alreadyTaken` for 19:00).
 *
 * The one rule (`named-slot.ts`): a named real slot counts when it lies
 * behind the take, however late, or when the take sits inside its window from
 * the early grace on. A slot further ahead does not bind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as intakePOST } from "@/app/api/medications/[id]/intake/route";
import { POST as bulkPOST } from "@/app/api/medications/intake/bulk/route";

import { callRoute } from "../kit/call-route";
import { makeMedication, makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: () => {},
}));

const prisma = getPrismaClient();
const DAY = "2026-11-21";
const at = (hm: string) => new Date(`${DAY}T${hm}:00.000Z`);

beforeEach(() => truncateAllTables(prisma));
afterEach(() => {
  vi.useRealTimers();
});

type Route = "single" | "bulk";

async function setup(clock: string, timesOfDay: string[]) {
  vi.useFakeTimers({ now: at(clock), toFake: ["Date"] });
  const user = await makeUser({ timezone: "UTC" });
  const auth = await makeSession(user);
  const medication = await makeMedication(
    user,
    { createdAt: new Date("2026-11-01T00:00:00.000Z") },
    [
      {
        windowStart: timesOfDay[0],
        windowEnd: timesOfDay[timesOfDay.length - 1],
        timesOfDay,
        scheduleType: "SCHEDULED",
      },
    ],
  );
  return { user, auth, medication };
}

/** Post one take on the given route; answer the stored row and its slot. */
async function take(
  route: Route,
  ctx: Awaited<ReturnType<typeof setup>>,
  body: { takenAt: Date; scheduledFor: Date; idempotencyKey: string },
): Promise<{
  status: number;
  entryStatus: string;
  slotInstant: string | null;
  scheduledFor: string | null;
}> {
  const wire = {
    takenAt: body.takenAt.toISOString(),
    scheduledFor: body.scheduledFor.toISOString(),
    idempotencyKey: body.idempotencyKey,
  };
  if (route === "single") {
    const res = await callRoute<{
      scheduledFor: string;
      slotInstant: string | null;
      alreadyTaken: boolean;
    }>(intakePOST, {
      method: "POST",
      route: "/api/medications/{id}/intake",
      params: { id: ctx.medication.id },
      body: { skipped: false, ...wire },
      auth: ctx.auth,
    });
    return {
      status: res.status,
      entryStatus: res.data.alreadyTaken ? "alreadyTaken" : "recorded",
      slotInstant: res.data.slotInstant,
      scheduledFor: res.data.scheduledFor,
    };
  }
  const res = await callRoute<{
    entries: Array<{ status: string; slotInstant: string | null; id?: string }>;
  }>(bulkPOST, {
    method: "POST",
    route: "/api/medications/intake/bulk",
    body: { entries: [{ medicationId: ctx.medication.id, ...wire }] },
    auth: ctx.auth,
  });
  const entry = res.data.entries[0];
  const row = entry.id
    ? await prisma.medicationIntakeEvent.findUnique({
        where: { id: entry.id },
        select: { scheduledFor: true },
      })
    : null;
  return {
    status: res.status,
    entryStatus: entry.status,
    slotInstant: entry.slotInstant,
    scheduledFor: row?.scheduledFor.toISOString() ?? null,
  };
}

describe.each<Route>(["single", "bulk"])("%s route", (route) => {
  it("a 20:00 dose taken at 19:30 with its slot named counts for 20:00", async () => {
    const ctx = await setup("19:30", ["20:00"]);
    const res = await take(route, ctx, {
      takenAt: at("19:30"),
      scheduledFor: at("20:00"),
      idempotencyKey: `early-${route}`,
    });
    expect(res.entryStatus).not.toBe("alreadyTaken");
    expect(res.slotInstant).toBe(at("20:00").toISOString());
    expect(res.scheduledFor).toBe(at("20:00").toISOString());
    const rows = await prisma.medicationIntakeEvent.findMany({
      where: { medicationId: ctx.medication.id, deletedAt: null },
      select: { scheduledFor: true, takenAt: true },
    });
    expect(rows).toEqual([{ scheduledFor: at("20:00"), takenAt: at("19:30") }]);
  });

  it("the due 20:00 dose taken at 19:30 counts for 20:00 when 19:00 is taken and the windows overlap", async () => {
    const ctx = await setup("19:30", ["19:00", "20:00"]);
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: ctx.user.id,
        medicationId: ctx.medication.id,
        scheduledFor: at("19:00"),
        takenAt: at("19:00"),
        source: "WEB",
        takenVia: "WEB",
      },
    });
    const res = await take(route, ctx, {
      takenAt: at("19:30"),
      scheduledFor: at("20:00"),
      idempotencyKey: `overlap-${route}`,
    });
    expect(res.entryStatus).not.toBe("alreadyTaken");
    expect(res.slotInstant).toBe(at("20:00").toISOString());
    const evening = await prisma.medicationIntakeEvent.findFirst({
      where: {
        medicationId: ctx.medication.id,
        scheduledFor: at("20:00"),
        deletedAt: null,
      },
      select: { takenAt: true, attributionSource: true },
    });
    expect(evening).toEqual({
      takenAt: at("19:30"),
      attributionSource: "USER_PIN",
    });
  });

  it("a named slot further ahead than its window does not bind: 12:00 for 20:00 is an extra dose", async () => {
    const ctx = await setup("12:00", ["20:00"]);
    const res = await take(route, ctx, {
      takenAt: at("12:00"),
      scheduledFor: at("20:00"),
      idempotencyKey: `ahead-${route}`,
    });
    expect(res.slotInstant).toBeNull();
    expect(res.scheduledFor).toBe(at("12:00").toISOString());
  });

  it("a named slot behind the take counts however late: 08:00 taken at 23:30", async () => {
    const ctx = await setup("23:30", ["08:00"]);
    const res = await take(route, ctx, {
      takenAt: at("23:30"),
      scheduledFor: at("08:00"),
      idempotencyKey: `late-${route}`,
    });
    expect(res.slotInstant).toBe(at("08:00").toISOString());
    expect(res.scheduledFor).toBe(at("08:00").toISOString());
  });
});
