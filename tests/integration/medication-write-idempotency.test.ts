/**
 * The three medication create routes the native client replays out of its
 * offline outbox, driven as routes against a real Postgres.
 *
 * Each case imports the shipped `POST` export and calls it twice with the same
 * `Idempotency-Key` — the real `apiHandler`, the real `requireRecordAuth`, the
 * real `withIdempotency`, the real Prisma writes. Nothing is reimplemented,
 * because the thing under test happens ABOVE the handler body: a test that
 * rebuilt the handler would prove its own copy of the wrapper works and would
 * keep passing after a route dropped it.
 *
 * The client sends the header on every replay, so a lost success response used
 * to cost the user a duplicate medication, a duplicate symptom entry, or a
 * duplicate pen in the supply count. `POST /api/medications` had a dedupe of
 * its own, but only for a MIRRORED create keyed on
 * `(externalSource, externalId)`; a manually entered medication carries
 * neither field and had nothing to collapse a retry onto — so the manual shape
 * is what this file posts.
 *
 * Two assertions per route, and the second is the one that matters: the replay
 * carries `X-Idempotent-Replay: true`, and the table holds exactly one row. A
 * status-only check would pass against a handler that wrote twice and answered
 * 201 twice. The medication case adds a third: a DIFFERENT key does create a
 * second row, so the single row above is the key's doing and not some other
 * uniqueness the fixture stumbled into.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-medication-idempotency-integration-1234567890abcdef";
// The side-effect note is encrypted at rest on the way in.
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const USER_ID = "user-medication-idempotency";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "medication-idempotency",
      email: "medication-idempotency@example.test",
      timezone: "UTC",
    },
  });
  const session = await getPrismaClient().session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

function post(path: string, body: unknown, idempotencyKey: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

/** A route whose params shape is its own business — see `sharing-delegable-routes`. */
type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

/** A medication to hang the side-effect and inventory writes off. */
async function seedMedication(): Promise<string> {
  const medication = await getPrismaClient().medication.create({
    data: { userId: USER_ID, name: "Fixture", dose: "1 tab" },
  });
  return medication.id;
}

const MANUAL_MEDICATION = {
  name: "Manually entered",
  dose: "10 mg",
  schedules: [
    { windowStart: "08:00", windowEnd: "08:30", timesOfDay: ["08:00"] },
  ],
};

describe("POST /api/medications — replayed manual create", () => {
  it("replays the first response and creates exactly one medication", async () => {
    const { POST } = await import("@/app/api/medications/route");

    const first = await POST(
      post("/api/medications", MANUAL_MEDICATION, "outbox-medication-1"),
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const replay = await POST(
      post("/api/medications", MANUAL_MEDICATION, "outbox-medication-1"),
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);

    const rows = await getPrismaClient().medication.findMany({
      where: { userId: USER_ID },
    });
    expect(rows).toHaveLength(1);
  });

  it("still creates a second medication under a different key", async () => {
    // The control on the case above: without it, a single row would also be
    // the reading if the create had silently failed the second time for an
    // unrelated reason.
    const { POST } = await import("@/app/api/medications/route");

    await POST(
      post("/api/medications", MANUAL_MEDICATION, "outbox-medication-a"),
    );
    const second = await POST(
      post("/api/medications", MANUAL_MEDICATION, "outbox-medication-b"),
    );
    expect(second.status).toBe(201);
    expect(second.headers.get("X-Idempotent-Replay")).toBeNull();

    const rows = await getPrismaClient().medication.findMany({
      where: { userId: USER_ID },
    });
    expect(rows).toHaveLength(2);
  });
});

describe("POST /api/medications/[id]/side-effects — replayed entry", () => {
  it("replays the first response and logs exactly one entry", async () => {
    const medicationId = await seedMedication();
    const { POST } =
      await import("@/app/api/medications/[id]/side-effects/route");
    const body = { entry: "NAUSEA", severity: 3, notes: "after breakfast" };

    const first = await (POST as Handler)(
      post(
        `/api/medications/${medicationId}/side-effects`,
        body,
        "outbox-side-effect-1",
      ),
      { params: Promise.resolve({ id: medicationId }) },
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const replay = await (POST as Handler)(
      post(
        `/api/medications/${medicationId}/side-effects`,
        body,
        "outbox-side-effect-1",
      ),
      { params: Promise.resolve({ id: medicationId }) },
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);

    const rows = await getPrismaClient().medicationSideEffect.findMany({
      where: { userId: USER_ID, medicationId },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("POST /api/medications/[id]/inventory — replayed container", () => {
  it("replays the first response and registers exactly one container", async () => {
    const medicationId = await seedMedication();
    const { POST } = await import("@/app/api/medications/[id]/inventory/route");
    const body = { unitsTotal: 30, containerType: "BLISTER" };

    const first = await (POST as Handler)(
      post(
        `/api/medications/${medicationId}/inventory`,
        body,
        "outbox-inventory-1",
      ),
      { params: Promise.resolve({ id: medicationId }) },
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const replay = await (POST as Handler)(
      post(
        `/api/medications/${medicationId}/inventory`,
        body,
        "outbox-inventory-1",
      ),
      { params: Promise.resolve({ id: medicationId }) },
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);

    const rows = await getPrismaClient().medicationInventoryItem.findMany({
      where: { userId: USER_ID, medicationId },
    });
    expect(rows).toHaveLength(1);
  });
});
