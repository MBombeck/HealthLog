/**
 * An undo names the version of the row it saw (`expectedSyncVersion`), and
 * every surface a client books or reads a dose through tells it that version:
 * the today rows, the per-medication take, the status route, the ingest hook
 * and each landed bulk entry. A version read from any of them undoes the
 * dose; a stale one answers 409 `medications.intake.changedSinceSeen` and
 * deletes nothing. `expectedIdempotencyKey` compares against the key the take
 * itself was sent with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  DAY_MS,
  TZ,
  perMedPost,
  readToday,
  statusPost,
} from "./medication-dose-state-fixtures";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-undo-sync-version-ingest-32-bytes-min-1234567";

vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: () => undefined,
}));
vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

// 08:10 in Berlin; the dose is due at 08:00.
const NOW = new Date("2026-11-21T07:10:00.000Z");
const SLOT = new Date("2026-11-21T07:00:00.000Z");

type Handler = (
  r: NextRequest,
  c: { params: Promise<Record<string, string>> },
) => Promise<Response>;

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "undo-version",
      email: "undo-version@example.test",
      role: "USER",
      timezone: TZ,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + DAY_MS) },
  });
  cookieJar.set("healthlog_session", session.id);
  const med = await prisma.medication.create({
    data: {
      userId: user.id,
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
  return { user, medId: med.id };
}

async function undo(
  medId: string,
  eventId: string,
  query: {
    expectedSyncVersion?: number | string;
    expectedIdempotencyKey?: string;
  },
) {
  const { DELETE } =
    await import("@/app/api/medications/[id]/intake/[eventId]/route");
  const qs = new URLSearchParams(
    Object.entries(query).map(([k, v]) => [k, String(v)]),
  );
  const res = await (DELETE as unknown as Handler)(
    new NextRequest(
      `http://localhost/api/medications/${medId}/intake/${eventId}?${qs}`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ id: medId, eventId }) },
  );
  const body = (await res.json()) as {
    meta?: { errorCode?: string };
  };
  return { status: res.status, errorCode: body.meta?.errorCode };
}

async function liveRows(medId: string) {
  return getPrismaClient().medicationIntakeEvent.findMany({
    where: { medicationId: medId, deletedAt: null },
  });
}

async function storedVersion(id: string) {
  const row = await getPrismaClient().medicationIntakeEvent.findUniqueOrThrow({
    where: { id },
  });
  return row.syncVersion;
}

const CHANGED = {
  status: 409,
  errorCode: "medications.intake.changedSinceSeen",
};

describe("an undo with the version a read returned", () => {
  it("today rows carry the current version: it undoes, a stale one is refused", async () => {
    const { medId } = await setup();
    const taken = await perMedPost(medId, {
      scheduledFor: SLOT.toISOString(),
    });
    expect(taken.status).toBe(201);
    const rows = await readToday();
    const row = rows.find((r) => r.medicationId === medId && r.takenAt) as
      (Record<string, unknown> & { id: string }) | undefined;
    expect(row).toBeDefined();
    expect(row!.syncVersion).toBe(await storedVersion(row!.id));

    expect(
      await undo(medId, row!.id, {
        expectedSyncVersion: (row!.syncVersion as number) + 1,
      }),
    ).toEqual(CHANGED);
    expect(await liveRows(medId)).toHaveLength(1);
    expect(
      await undo(medId, row!.id, {
        expectedSyncVersion: row!.syncVersion as number,
      }),
    ).toMatchObject({ status: 200 });
    expect(await liveRows(medId)).toHaveLength(0);
  });

  it("the per-medication take answers the version, and the key it was sent with", async () => {
    const { medId } = await setup();
    const res = await perMedPost(medId, {
      scheduledFor: SLOT.toISOString(),
      idempotencyKey: "tap-1",
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { id: string; syncVersion: number; idempotencyKey: string };
    };
    expect(data.syncVersion).toBe(await storedVersion(data.id));
    expect(data.idempotencyKey).toBe("tap-1");

    expect(
      await undo(medId, data.id, { expectedIdempotencyKey: "tap-2" }),
    ).toEqual(CHANGED);
    expect(
      await undo(medId, data.id, { expectedSyncVersion: data.syncVersion + 1 }),
    ).toEqual(CHANGED);
    expect(
      await undo(medId, data.id, {
        expectedSyncVersion: data.syncVersion,
        expectedIdempotencyKey: "tap-1",
      }),
    ).toMatchObject({ status: 200 });
  });

  it("the status route answers the bumped version", async () => {
    const { medId } = await setup();
    // A pending row the take moves to taken.
    await readToday();
    const pending = (await liveRows(medId))[0];
    expect(pending).toBeDefined();
    const res = await statusPost({ intakeId: pending.id, status: "taken" });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { id: string; syncVersion: number };
    };
    expect(data.syncVersion).toBe(await storedVersion(data.id));
    expect(data.syncVersion).toBeGreaterThan(pending.syncVersion);

    expect(
      await undo(medId, data.id, { expectedSyncVersion: pending.syncVersion }),
    ).toEqual(CHANGED);
    expect(
      await undo(medId, data.id, { expectedSyncVersion: data.syncVersion }),
    ).toMatchObject({ status: 200 });
  });

  it("the ingest hook answers the version and the key the take was sent with", async () => {
    const { user, medId } = await setup();
    const { hashToken } = await import("@/lib/auth/hmac");
    const raw = `hlk_undover_${"0".repeat(48)}`;
    await getPrismaClient().apiToken.create({
      data: {
        userId: user.id,
        name: "pill box",
        tokenHash: hashToken(raw),
        permissions: ["medication:ingest", `medication:${medId}:ingest`],
      },
    });
    const { POST } = await import("@/app/api/ingest/medication/route");
    const res = await POST(
      new NextRequest("https://health.example/api/ingest/medication", {
        method: "POST",
        headers: {
          authorization: `Bearer ${raw}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          medicationName: "Ramipril",
          idempotencyKey: "box-1",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { id: string; syncVersion: number; idempotencyKey: string };
    };
    expect(data.syncVersion).toBe(await storedVersion(data.id));
    expect(data.idempotencyKey).toBe("box-1");
    expect(
      await undo(medId, data.id, { expectedIdempotencyKey: "phone-1" }),
    ).toEqual(CHANGED);
    expect(
      await undo(medId, data.id, {
        expectedSyncVersion: data.syncVersion,
        expectedIdempotencyKey: "box-1",
      }),
    ).toMatchObject({ status: 200 });
  });

  it("each landed bulk entry carries the settled version; alreadyTaken's intake the same", async () => {
    const { medId } = await setup();
    const { POST } = await import("@/app/api/medications/intake/bulk/route");
    const send = async (entries: unknown[]) => {
      const res = await (
        POST as unknown as (r: NextRequest) => Promise<Response>
      )(
        new NextRequest("http://localhost/api/medications/intake/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entries }),
        }),
      );
      expect(res.status).toBeLessThan(300);
      return (
        (await res.json()) as {
          data: {
            entries: Array<{
              status: string;
              id?: string;
              syncVersion?: number;
              intake?: { syncVersion: number; idempotencyKey: string | null };
            }>;
          };
        }
      ).data.entries;
    };
    const entry = {
      medicationId: medId,
      scheduledFor: SLOT.toISOString(),
      takenAt: NOW.toISOString(),
      idempotencyKey: "bulk-1",
    };
    const [first] = await send([entry]);
    expect(first.id).toBeDefined();
    expect(first.syncVersion).toBe(await storedVersion(first.id!));

    const [again] = await send([{ ...entry, idempotencyKey: "bulk-2" }]);
    expect(again.status).toBe("alreadyTaken");
    expect(again.syncVersion).toBe(first.syncVersion);
    expect(again.intake?.syncVersion).toBe(first.syncVersion);
    // The recorded row keeps the key of the take that wrote it.
    expect(again.intake?.idempotencyKey).toBe("bulk-1");

    expect(
      await undo(medId, first.id!, { expectedIdempotencyKey: "bulk-2" }),
    ).toEqual(CHANGED);
    expect(
      await undo(medId, first.id!, {
        expectedSyncVersion: first.syncVersion! + 1,
      }),
    ).toEqual(CHANGED);
    expect(
      await undo(medId, first.id!, {
        expectedSyncVersion: first.syncVersion!,
        expectedIdempotencyKey: "bulk-1",
      }),
    ).toMatchObject({ status: 200 });
    expect(await liveRows(medId)).toHaveLength(0);
  });

  it.each([
    ["a negative version", { expectedSyncVersion: "-1" }],
    ["a fractional version", { expectedSyncVersion: "1.5" }],
    ["a non-number version", { expectedSyncVersion: "abc" }],
    ["an empty version", { expectedSyncVersion: "" }],
    ["an empty key", { expectedIdempotencyKey: "" }],
    ["a key over 128 characters", { expectedIdempotencyKey: "k".repeat(129) }],
  ])("refuses %s with 422 and deletes nothing", async (_, query) => {
    const { medId } = await setup();
    const res = await perMedPost(medId, {
      scheduledFor: SLOT.toISOString(),
      idempotencyKey: "tap-1",
    });
    const { data } = (await res.json()) as { data: { id: string } };
    expect(await undo(medId, data.id, query)).toEqual({
      status: 422,
      errorCode: "medications.intake.invalidPrecondition",
    });
    expect(await liveRows(medId)).toHaveLength(1);
  });

  it("still undoes without any precondition", async () => {
    const { medId } = await setup();
    const res = await perMedPost(medId, { scheduledFor: SLOT.toISOString() });
    const { data } = (await res.json()) as { data: { id: string } };
    expect(await undo(medId, data.id, {})).toMatchObject({ status: 200 });
    expect(await liveRows(medId)).toHaveLength(0);
  });
});
