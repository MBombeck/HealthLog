/**
 * A duplicate measurement answers 409, not 500 — on both write paths.
 *
 * `Measurement` carries a unique index over the natural key, so posting the
 * same reading twice is an ordinary, expected outcome: a double tap, a retry
 * after a dropped response, an importer replaying a page. The route has always
 * meant to answer it with `409 measurement.duplicate_timestamp`.
 *
 * Two things stopped it:
 *
 *   * the single-entry path narrowed the error with
 *     `instanceof Prisma.PrismaClientKnownRequestError`, the exact form
 *     `src/lib/prisma-errors.ts` exists to replace — its docblock says the
 *     structural check is used "so it survives client-bundling quirks", and
 *     when the `instanceof` misses, the duplicate escapes unhandled;
 *   * the BATCH path had no P2002 handling at all. One duplicate anywhere in
 *     the transaction rolled the whole batch back and answered 500.
 *
 * A 500 is indistinguishable from a server fault, and every client retries
 * against it — so the failure mode was a retry loop hammering a write that
 * could never succeed. That is why this is worth an integration test rather
 * than a unit one: it needs the real unique index to raise the real error.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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

let counter = 0;

const MEASURED_AT = "2026-03-04T07:30:00.000Z";

async function signIn() {
  const user = await getPrismaClient().user.create({
    data: {
      username: `dup-${counter}`,
      email: `dup-${counter++}@example.test`,
      role: "USER",
    },
  });
  const session = await getPrismaClient().session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

function post(body: unknown): Promise<Response> {
  return import("@/app/api/measurements/route").then(({ POST }) =>
    POST(
      new NextRequest("http://localhost/api/measurements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

const single = { type: "WEIGHT", value: 81.2, measuredAt: MEASURED_AT };

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("POST /api/measurements — a duplicate is a conflict, not a fault", () => {
  it("answers the single-entry duplicate with 409 and a stable code", async () => {
    await signIn();

    const first = await post(single);
    expect(first.status).toBe(201);

    const second = await post(single);
    const body = await second.json();

    // Not 500. A 500 is a server fault, and a client that retries against one
    // retries forever against a write that can never succeed.
    expect(second.status).toBe(409);
    expect(body.meta.errorCode).toBe("measurement.duplicate_timestamp");
    expect(await getPrismaClient().measurement.count()).toBe(1);
  });

  it("answers a duplicate inside a BATCH with 409 rather than 500", async () => {
    const user = await signIn();

    const first = await post(single);
    expect(first.status).toBe(201);

    // A batch whose second entry collides with the row above. The transaction
    // rolls back either way; what is under test is what the caller is told.
    // Batch mode is a bare ARRAY body, which is what the route branches on.
    const batch = await post([
      { type: "WEIGHT", value: 79.9, measuredAt: "2026-03-05T07:30:00.000Z" },
      single,
    ]);
    const body = await batch.json();

    expect(batch.status).toBe(409);
    expect(body.meta.errorCode).toBe("measurement.duplicate_timestamp");
    // Rolled back whole: the non-colliding entry did not land either, which is
    // what a single transaction means and what the 409 has to be read against.
    expect(
      await getPrismaClient().measurement.count({ where: { userId: user.id } }),
    ).toBe(1);
  });

  it("POSITIVE CONTROL: a batch with no duplicate still writes every row", async () => {
    // Without this the two assertions above would pass for a route that had
    // started refusing every batch.
    const user = await signIn();

    const batch = await post([
      { type: "WEIGHT", value: 79.9, measuredAt: "2026-03-05T07:30:00.000Z" },
      { type: "WEIGHT", value: 80.1, measuredAt: "2026-03-06T07:30:00.000Z" },
    ]);

    expect(batch.status).toBe(201);
    expect(
      await getPrismaClient().measurement.count({ where: { userId: user.id } }),
    ).toBe(2);
  });

  it("POSITIVE CONTROL: a different reading at the same instant still writes", async () => {
    // The unique key includes `type`, so this is not a duplicate — and a route
    // that answered 409 for every same-timestamp write would break every day a
    // blood-pressure reading and a pulse arrive together.
    const user = await signIn();

    expect((await post(single)).status).toBe(201);
    const other = await post({
      type: "PULSE",
      value: 62,
      measuredAt: MEASURED_AT,
    });

    expect(other.status).toBe(201);
    expect(
      await getPrismaClient().measurement.count({ where: { userId: user.id } }),
    ).toBe(2);
  });

  it("revives a deleted hand entry at the same minute instead of answering 409", async () => {
    // Typed it wrong, deleted it, entered it again: the tombstone holds the
    // reading key for 75 days, and a MANUAL entry takes it over.
    const user = await signIn();
    const first = await post(single);
    expect(first.status).toBe(201);
    const original = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: user.id },
    });
    await getPrismaClient().measurement.update({
      where: { id: original.id },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });

    const again = await post({ ...single, value: 81.4 });

    expect(again.status).toBe(201);
    const rows = await getPrismaClient().measurement.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: original.id,
      value: 81.4,
      deletedAt: null,
    });
    // Raised past the deletion's version, so a device that synced the
    // deletion receives the reading again.
    expect(rows[0].syncVersion).toBeGreaterThan(original.syncVersion + 1);
  });

  it("revives deleted entries inside a batch too, and still refuses a live duplicate", async () => {
    const user = await signIn();
    const pair = [
      { type: "BLOOD_PRESSURE_SYS", value: 128, measuredAt: MEASURED_AT },
      { type: "BLOOD_PRESSURE_DIA", value: 82, measuredAt: MEASURED_AT },
    ];
    expect((await post(pair)).status).toBe(201);
    await getPrismaClient().measurement.updateMany({
      where: { userId: user.id },
      data: { deletedAt: new Date() },
    });

    const again = await post([
      { ...pair[0], value: 126 },
      { ...pair[1], value: 80 },
    ]);
    expect(again.status).toBe(201);
    const live = await getPrismaClient().measurement.findMany({
      where: { userId: user.id, deletedAt: null },
      select: { type: true, value: true },
    });
    expect(live.sort((a, b) => a.type.localeCompare(b.type))).toEqual([
      { type: "BLOOD_PRESSURE_DIA", value: 80 },
      { type: "BLOOD_PRESSURE_SYS", value: 126 },
    ]);
    expect(
      await getPrismaClient().measurement.count({ where: { userId: user.id } }),
    ).toBe(2);

    // Live now, so a third entry at the same minute is a duplicate again.
    expect((await post(pair)).status).toBe(409);
  });
});
