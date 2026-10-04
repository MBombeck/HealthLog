/**
 * One `Idempotency-Key`, two different requests.
 *
 * Native clients up to 1.1.0 post a manual blood pressure as two
 * `POST /api/measurements` calls — the systolic half, then the diastolic half —
 * under the same key. While the replay cell was keyed on
 * `(user, key, method, path)` alone, the second call was answered with the
 * first call's cached 201 and the diastolic value was never written. The cell
 * now carries a fingerprint of the request body: only the same body replays.
 *
 * Everything here is real — the shipped route, the shipped wrapper, the
 * session resolver and the `idempotency_keys` unique index.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postMeasurement } from "@/app/api/measurements/route";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

const USER_A = "idem-fingerprint-a";
const USER_B = "idem-fingerprint-b";
const KEY = "bp-entry-5c1e2a7f";
const MEASURED_AT = "2026-09-30T07:15:00.000Z";

const SYS = { type: "BLOOD_PRESSURE_SYS", value: 128, measuredAt: MEASURED_AT };
const DIA = { type: "BLOOD_PRESSURE_DIA", value: 84, measuredAt: MEASURED_AT };

const sessions = new Map<string, string>();

function post(body: unknown, key = KEY): Promise<Response> {
  return postMeasurement(
    new NextRequest("http://localhost/api/measurements", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    }),
  );
}

function signInAs(userId: string) {
  cookieJar.set("healthlog_session", sessions.get(userId)!);
}

async function rowsOf(userId: string) {
  const rows = await getPrismaClient().measurement.findMany({
    where: { userId, deletedAt: null },
    select: { type: true, value: true },
  });
  // By name, not by the enum's declaration order.
  return rows.sort((a, b) => a.type.localeCompare(b.type));
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  sessions.clear();
  for (const id of [USER_A, USER_B]) {
    await prisma.user.create({
      data: {
        id,
        username: id,
        email: `${id}@example.test`,
        timezone: "UTC",
      },
    });
    const session = await prisma.session.create({
      data: { userId: id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    sessions.set(id, session.id);
  }
  signInAs(USER_A);
});

describe("Idempotency-Key reused for a different body (real Postgres)", () => {
  it("writes both halves of a blood pressure posted under one key", async () => {
    const first = await post(SYS);
    expect(first.status).toBe(201);

    const second = await post(DIA);
    expect(second.status).toBe(201);
    expect(second.headers.get("X-Idempotent-Replay")).toBeNull();

    expect(await rowsOf(USER_A)).toEqual([
      { type: "BLOOD_PRESSURE_DIA", value: 84 },
      { type: "BLOOD_PRESSURE_SYS", value: 128 },
    ]);
  });

  it("still replays a retry of the same body and writes one row", async () => {
    const first = await post(SYS);
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    // Same object, different key order: the same request.
    const retry = await post({
      measuredAt: MEASURED_AT,
      value: 128,
      type: "BLOOD_PRESSURE_SYS",
    });
    expect(retry.status).toBe(201);
    expect(retry.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await retry.json()).toEqual(firstBody);

    expect(await rowsOf(USER_A)).toEqual([
      { type: "BLOOD_PRESSURE_SYS", value: 128 },
    ]);
  });

  it("keeps the first cell answering its own retries after a different body ran", async () => {
    await post(SYS);
    await post(DIA);
    const retry = await post(SYS);
    expect(retry.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await rowsOf(USER_A)).toHaveLength(2);
    const cells = await getPrismaClient().idempotencyKey.findMany({
      where: { userId: USER_A },
    });
    expect(cells).toHaveLength(1);
    expect(cells[0]?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes both halves when they are in flight at the same time", async () => {
    const [a, b] = await Promise.all([post(SYS), post(DIA)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await rowsOf(USER_A)).toEqual([
      { type: "BLOOD_PRESSURE_DIA", value: 84 },
      { type: "BLOOD_PRESSURE_SYS", value: 128 },
    ]);
  });

  it("still lets only one of two identical bodies in flight run", async () => {
    const [a, b] = await Promise.all([post(SYS), post(SYS)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await rowsOf(USER_A)).toHaveLength(1);
  });

  it("does not replay a row written before fingerprints existed", async () => {
    await getPrismaClient().idempotencyKey.create({
      data: {
        userId: USER_A,
        key: KEY,
        method: "POST",
        path: "/api/measurements",
        responseStatus: 201,
        responseBody: JSON.stringify({ data: { id: "legacy" }, error: null }),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const res = await post(DIA);
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Idempotent-Replay")).toBeNull();
    expect(await rowsOf(USER_A)).toEqual([
      { type: "BLOOD_PRESSURE_DIA", value: 84 },
    ]);
    // The legacy row is left alone, not claimed over.
    const cell = await getPrismaClient().idempotencyKey.findFirstOrThrow({
      where: { userId: USER_A, key: KEY },
    });
    expect(cell.requestFingerprint).toBeNull();
  });

  it("never hands one user's cached response to another using the same key", async () => {
    const first = await post(SYS);
    const firstBody = await first.json();

    signInAs(USER_B);
    const other = await post(SYS);
    expect(other.status).toBe(201);
    expect(other.headers.get("X-Idempotent-Replay")).toBeNull();
    expect(await other.json()).not.toEqual(firstBody);

    expect(await rowsOf(USER_A)).toHaveLength(1);
    expect(await rowsOf(USER_B)).toHaveLength(1);
  });

  it("the documented operator query finds a systolic reading left without its diastolic half", async () => {
    const doc = readFileSync(
      join(process.cwd(), "docs/ops/blood-pressure-missing-diastolic.md"),
      "utf8",
    );
    const block =
      /<!-- bp-missing-diastolic:start -->([\s\S]*?)<!-- bp-missing-diastolic:end -->/.exec(
        doc,
      );
    const sql = block?.[1]
      .replace(/```sql|```/g, "")
      .trim()
      .replace(/;$/, "");
    expect(sql).toBeTruthy();

    // A complete reading through the fixed path, and the damage the old
    // cache left behind: a systolic half on its own.
    await post(SYS);
    await post(DIA);
    const lone = await getPrismaClient().measurement.create({
      data: {
        userId: USER_A,
        type: "BLOOD_PRESSURE_SYS",
        value: 141,
        unit: "mmHg",
        measuredAt: new Date("2026-09-29T19:40:00.000Z"),
      },
    });

    const found = await getPrismaClient().$queryRawUnsafe<
      Array<{ id: string; systolic: number }>
    >(sql!);
    expect(found.map((r) => [r.id, r.systolic])).toEqual([[lone.id, 141]]);
  });
});
