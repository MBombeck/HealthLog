/**
 * Backfilling a missed dose from the Verlauf ledger must record THAT slot.
 *
 * The ledger's "Genommen" action posts the displayed slot's own anchor as
 * `scheduledFor` with `takenAt = now`, meaning "record this dose". The route
 * resolved the slot by window band from `takenAt` instead, so a backfill of a
 * slot from an earlier day matched no band, fell through to the standalone
 * insert, and landed as an ad-hoc row anchored at the recording moment. The
 * named slot stayed unserved: the optimistic row flipped to taken, the
 * authoritative refetch read the slot as missed again, and the entry the user
 * had just made was gone from the day they made it for.
 *
 * Everything here goes through the shipped `POST` / `GET` exports so the real
 * `apiHandler`, the real auth resolution and the real Prisma writes answer.
 * The assertions are on the persisted row AND on the ledger the tab reads
 * back — the pipe between them is where the entry disappeared.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

import { localHmAsUtc } from "@/lib/tz/local-day";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const TZ = "Europe/Berlin";
const DAY_MS = 24 * 60 * 60 * 1000;

let counter = 0;

async function makeUser() {
  const suffix = `backfill-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `bf-${suffix}`,
      email: `bf-${suffix}@example.test`,
      role: "USER",
      timezone: TZ,
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

/**
 * Slot hours placed so neither dose window can contain the moment the test
 * runs. A band spans roughly [anchor − 1 h, anchor + 4 h]; +5 h and +12 h from
 * the current local hour keep "now" outside both on every clock, so the
 * assertions never depend on when the suite happens to run.
 */
function slotHours(): { a: number; b: number } {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  );
  return { a: (hour + 5) % 24, b: (hour + 12) % 24 };
}

async function seedTwiceDaily(userId: string, hours: { a: number; b: number }) {
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const med = await getPrismaClient().medication.create({
    data: {
      userId,
      name: "Ramipril",
      dose: "5mg",
      active: true,
      startsOn: new Date(Date.now() - 30 * DAY_MS),
      // The ledger shows an unrecorded slot only from the medication's
      // creation on, so a medication minted at test time would have no
      // missed yesterday to read back.
      createdAt: new Date(Date.now() - 30 * DAY_MS),
      schedules: {
        create: {
          windowStart: hh(hours.a),
          windowEnd: hh(hours.b),
          timesOfDay: [hh(hours.a), hh(hours.b)],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  return med.id;
}

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

async function postIntake(medicationId: string, body: unknown) {
  const { POST } = await import("@/app/api/medications/[id]/intake/route");
  return (POST as Handler)(
    new NextRequest(`http://localhost/api/medications/${medicationId}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: medicationId }) },
  );
}

async function readLedger(medicationId: string, from: Date, to: Date) {
  const { GET } = await import("@/app/api/medications/[id]/dose-history/route");
  const search = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const response = await (GET as Handler)(
    new NextRequest(
      `http://localhost/api/medications/${medicationId}/dose-history?${search}`,
      { method: "GET" },
    ),
    { params: Promise.resolve({ id: medicationId }) },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: {
      rows: {
        kind: string;
        at: string;
        status: string;
        intake: { takenAt: string | null } | null;
      }[];
    };
  };
  return body.data.rows;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("POST /api/medications/[id]/intake — backfilling a missed slot", () => {
  it("records the named slot from an earlier day, not an ad-hoc row at 'now'", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser();
    await signIn(user.id);
    const hours = slotHours();
    const medicationId = await seedTwiceDaily(user.id, hours);

    // Yesterday's first slot: long past its overdue tail, so the ledger reads
    // it as missed and the kebab offers "Genommen".
    const missedSlot = localHmAsUtc(
      new Date(Date.now() - DAY_MS),
      TZ,
      hours.a,
      0,
    );

    const response = await postIntake(medicationId, {
      skipped: false,
      scheduledFor: missedSlot.toISOString(),
      takenAt: new Date().toISOString(),
    });
    expect(response.status).toBe(201);

    // The row lands ON the slot the user marked.
    const rows = await prisma.medicationIntakeEvent.findMany({
      where: { userId: user.id, medicationId, deletedAt: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scheduledFor.getTime()).toBe(missedSlot.getTime());
    expect(rows[0]?.takenAt).not.toBeNull();
    expect(rows[0]?.skipped).toBe(false);
  });

  it("the ledger reads the backfilled slot as taken, not missed", async () => {
    const user = await makeUser();
    await signIn(user.id);
    const hours = slotHours();
    const medicationId = await seedTwiceDaily(user.id, hours);
    const missedSlot = localHmAsUtc(
      new Date(Date.now() - DAY_MS),
      TZ,
      hours.a,
      0,
    );

    await postIntake(medicationId, {
      skipped: false,
      scheduledFor: missedSlot.toISOString(),
      takenAt: new Date().toISOString(),
    });

    const rows = await readLedger(
      medicationId,
      new Date(Date.now() - 3 * DAY_MS),
      new Date(),
    );
    const slotRow = rows.find(
      (r) => r.kind === "slot" && r.at === missedSlot.toISOString(),
    );
    expect(slotRow).toBeDefined();
    expect(slotRow?.status).toMatch(/^taken_/);
    expect(slotRow?.intake?.takenAt).not.toBeNull();
    // And no orphan ad-hoc row at the recording moment.
    expect(rows.filter((r) => r.kind === "ad_hoc")).toHaveLength(0);
  });

  it("still refuses to fill a slot that lies ahead of the take", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser();
    await signIn(user.id);
    const hours = slotHours();
    const medicationId = await seedTwiceDaily(user.id, hours);

    // Tomorrow's first slot — the "late-morning dose must not consume the
    // evening slot" invariant, stated across a day boundary so it holds
    // whatever the clock says when the suite runs.
    const futureSlot = localHmAsUtc(
      new Date(Date.now() + DAY_MS),
      TZ,
      hours.a,
      0,
    );

    const response = await postIntake(medicationId, {
      skipped: false,
      scheduledFor: futureSlot.toISOString(),
      takenAt: new Date().toISOString(),
    });
    expect(response.status).toBe(201);

    const onFutureSlot = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: user.id,
        medicationId,
        scheduledFor: futureSlot,
        deletedAt: null,
      },
    });
    expect(onFutureSlot).toHaveLength(0);

    const all = await prisma.medicationIntakeEvent.findMany({
      where: { userId: user.id, medicationId, deletedAt: null },
    });
    expect(all).toHaveLength(1);
    expect(all[0]?.scheduledFor.getTime()).toBeLessThan(futureSlot.getTime());
  });
});
