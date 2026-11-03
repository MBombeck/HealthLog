/**
 * The replay cache is scoped to the RECORD, not only to the caller.
 *
 * One delegate, two people's records, one `Idempotency-Key`. Before this was
 * fixed the cell was `(caller, key, method, path)`, so the second record's
 * request replayed the first record's cached 201: no handler, no row, and a
 * success response carrying the other person's id. Nothing errored and nothing
 * logged a conflict, which is why it needed a test rather than a bug report.
 *
 * Everything under the test is real — the shipped wrapper, the shipped
 * resolver, the shipped grant module's tables, the composite unique index and
 * the `user_id` foreign key. The handler is assembled here rather than imported
 * because what is under test is the cell, not any one domain's write path; a
 * shipped route would bind this file to that route's schema and its migration
 * to a delegable mode.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  ACCOUNT_SELECTOR_HEADER,
  apiHandler,
  requireRecordAuth,
} from "@/lib/api-handler";
import { hashToken } from "@/lib/auth/hmac";
import { prisma } from "@/lib/db";
import { withIdempotency } from "@/lib/idempotency";

const KEY = "retry-0f3a1c9d";

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `cell-${suffix}`,
      email: `cell-${suffix}@example.test`,
      role: "USER",
    },
  });
}

async function mintToken(userId: string): Promise<string> {
  const raw = `hlk_${userId}-${counter++}`.padEnd(20, "0");
  await getPrismaClient().apiToken.create({
    data: {
      userId,
      name: "idempotency-cell-test",
      tokenHash: hashToken(raw),
      permissions: ["*"],
    },
  });
  return raw;
}

/**
 * An accepted WRITE grant, written directly.
 *
 * `inviteGrant()` mints READ today; the level is Chunk B's to open. What this
 * file needs is a row in the state the resolver reads, and that state is the
 * two columns below.
 */
async function writeGrant(grantorId: string, granteeId: string) {
  return getPrismaClient().accountGrant.create({
    data: {
      grantorId,
      granteeId,
      access: "WRITE",
      acceptedAt: new Date(Date.now() - 60_000),
    },
  });
}

let handlerRuns = 0;

/**
 * A delegated write, wrapped exactly as the shipped routes wrap one:
 * `apiHandler(withIdempotency(handler))`.
 */
const delegableWrite: (request: NextRequest) => Promise<Response> = apiHandler(
  withIdempotency<[NextRequest]>(async () => {
    handlerRuns += 1;
    const { user } = await requireRecordAuth("write", "measurements");
    const row = await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 80 + handlerRuns,
        unit: "kg",
        measuredAt: new Date(),
        source: "MANUAL",
      },
    });
    return NextResponse.json(
      { data: { id: row.id, userId: row.userId }, error: null },
      { status: 201 },
    );
  }),
);

function post(key: string | null = KEY): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (key) headers["idempotency-key"] = key;
  return delegableWrite(
    new NextRequest("http://localhost/api/test/delegable-write", {
      method: "POST",
      headers,
      body: JSON.stringify({ ok: true }),
    }),
  );
}

/** Point the next request at a record. */
function actAs(ownerId: string | null): void {
  if (ownerId === null) headerJar.delete(ACCOUNT_SELECTOR_HEADER);
  else headerJar.set(ACCOUNT_SELECTOR_HEADER, ownerId);
}

async function measurementsOf(userId: string) {
  return getPrismaClient().measurement.findMany({ where: { userId } });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  handlerRuns = 0;
});

describe("the replay cell is per record", () => {
  it("writes to BOTH records when one key is reused across two owners", async () => {
    const delegate = await makeUser("delegate");
    const ownerA = await makeUser("owner-a");
    const ownerB = await makeUser("owner-b");
    await writeGrant(ownerA.id, delegate.id);
    await writeGrant(ownerB.id, delegate.id);
    headerJar.set("authorization", `Bearer ${await mintToken(delegate.id)}`);

    actAs(ownerA.id);
    const first = await post();
    expect(first.status).toBe(201);
    expect((await first.json()).data.userId).toBe(ownerA.id);

    // Same caller, same key, same path — a different person's record. The
    // handler must run again, because nothing about this request was answered
    // by the previous one.
    actAs(ownerB.id);
    const second = await post();
    expect(second.status).toBe(201);
    const secondBody = await second.json();

    // Asserted first because it is the damage: without a per-record cell this
    // is an empty list, and the caller was told 201.
    expect(await measurementsOf(ownerB.id)).toHaveLength(1);
    expect(secondBody.data.userId).toBe(ownerB.id);
    expect(second.headers.get("X-Idempotent-Replay")).not.toBe("true");
    expect(handlerRuns).toBe(2);
    expect(await measurementsOf(ownerA.id)).toHaveLength(1);
    // Two cells under the one caller: the actor's id still owns both rows, so
    // the foreign key and its cascade are untouched by the fold.
    const cells = await getPrismaClient().idempotencyKey.findMany({
      where: { userId: delegate.id },
    });
    expect(cells).toHaveLength(2);
  });

  it("still replays a genuine retry on the SAME record", async () => {
    const delegate = await makeUser("delegate");
    const owner = await makeUser("owner");
    await writeGrant(owner.id, delegate.id);
    headerJar.set("authorization", `Bearer ${await mintToken(delegate.id)}`);
    actAs(owner.id);

    const first = await post();
    const firstBody = await first.json();
    const replay = await post();

    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    expect(handlerRuns).toBe(1);
    expect(await measurementsOf(owner.id)).toHaveLength(1);
  });

  it("keys a request with no acting account exactly as the client sent it", async () => {
    const caller = await makeUser("self");
    headerJar.set("authorization", `Bearer ${await mintToken(caller.id)}`);

    const response = await post();
    expect(response.status).toBe(201);

    // The self path is the pre-existing path and must stay byte-identical:
    // same owner column, same key column, no separator, no prefix.
    const cells = await getPrismaClient().idempotencyKey.findMany();
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ userId: caller.id, key: KEY });
    expect(await measurementsOf(caller.id)).toHaveLength(1);
  });
});
