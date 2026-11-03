/**
 * FENCE-AC-05 — an idempotent write whose record context moved between the
 * client forming its intent and the server receiving it.
 *
 * The dangerous shape is specific. A tab posts a mutation to the owner's record
 * with an `Idempotency-Key`, the selector moves out of band, and the retry
 * arrives. Without a fence above the cache the retry either replays the owner's
 * cached body under the new context, or files a fresh claim in a cell it has no
 * business choosing. Either way nothing errors.
 *
 * ## What is asserted, and what deliberately is not
 *
 * The seeded owner cell is asserted BYTE-UNCHANGED — same id, same
 * `responseStatus`, same `responseBody`, same `expiresAt` — because that is
 * falsifiable. `expiresAt` carries the weight: the completion path rewrites it
 * to `now + 24h` and a fresh claim rewrites it to `now + 2min`, so a wrapper
 * that reached the cache at all would move it. The obvious alternative,
 * "no row exists for the target cell", is not: `releaseClaim` deletes the
 * pending row whenever the handler throws, so that assertion passes with the
 * fence placed after `claimKey` too. The zero-call proof for `findUnique` /
 * `create` lives one layer down in `src/lib/__tests__/idempotency.test.ts`,
 * where the Prisma calls can be spied on directly.
 *
 * Everything under the test is real: the shipped wrapper, the shipped resolver,
 * the composite unique index, the trigger that moves the epoch.
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

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { withIdempotency } from "@/lib/idempotency";
import {
  RECORD_EPOCH_HEADER,
  RECORD_FENCE_ERROR_CODE,
  RECORD_SCOPE_HEADER,
  RECORD_SCOPE_SELF,
} from "@/lib/sharing/record-session-fence-contract";

const KEY = "retry-7c21ab04";

let counter = 0;
let handlerRuns = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `fence-idem-${suffix}`,
      email: `fence-idem-${suffix}@example.test`,
      role: "USER",
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

/** The shipped composition: `apiHandler(withIdempotency(handler))`. */
const delegableWrite: (request: NextRequest) => Promise<Response> = apiHandler(
  withIdempotency<[NextRequest]>(async () => {
    const { user } = await requireRecordAuth("write", "measurements");
    // Counted AFTER the resolver, so it means "the handler body ran" rather
    // than "the wrapper called through". The wrapper deliberately calls
    // through on an `unfenced-client` verdict so the route can issue its own
    // refusal, and a counter incremented above this line would report that
    // pass-through as a side effect having happened.
    handlerRuns += 1;
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

function post(): Promise<Response> {
  return delegableWrite(
    new NextRequest("http://localhost/api/test/delegable-write", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": KEY,
      },
      body: JSON.stringify({ value: 81 }),
    }),
  );
}

function assertContext(epoch: number, scope: string | null): void {
  headerJar.set(RECORD_EPOCH_HEADER, String(epoch));
  headerJar.set(RECORD_SCOPE_HEADER, scope ?? RECORD_SCOPE_SELF);
}

async function switchOutOfBand(sessionId: string, target: string | null) {
  await getPrismaClient().session.update({
    where: { id: sessionId },
    data: { actingAsUserId: target },
  });
  const row = await getPrismaClient().session.findUniqueOrThrow({
    where: { id: sessionId },
  });
  return row.recordEpoch;
}

async function cells() {
  return getPrismaClient().idempotencyKey.findMany({ orderBy: { key: "asc" } });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  handlerRuns = 0;
});

describe("FENCE-AC-05 an idempotent write under a moved record context", () => {
  it("FENCE-AC-05 refuses the replay, leaves the seeded owner cell byte-unchanged, and writes to neither record", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await writeGrant(owner.id, delegate.id);
    const session = await signIn(delegate.id);

    // A completed owner cell for key K, written by the real path.
    const inRecord = await switchOutOfBand(session.id, owner.id);
    assertContext(inRecord, owner.id);
    const first = await post();
    expect(first.status).toBe(201);
    expect(handlerRuns).toBe(1);

    const seeded = await cells();
    expect(seeded).toHaveLength(1);
    const before = seeded[0];
    expect(before.responseStatus).toBe(201);

    // The selector moves out of band. The tab knows nothing about it and
    // retries the same key under the context it formed its intent in.
    const afterSwitch = await switchOutOfBand(session.id, null);
    expect(afterSwitch).toBe(inRecord + 1);

    const replay = await post();
    const body = await replay.json();

    // (a) refused
    expect(replay.status).toBe(409);
    expect(body.meta.errorCode).toBe(RECORD_FENCE_ERROR_CODE);

    // (b) the seeded cell is untouched — nothing read it, claimed it, or
    // rewrote it. `expiresAt` is the falsifiable half: completion rewrites it
    // to now+24h and a fresh claim to now+2min, so a wrapper that reached the
    // cache at all would move it.
    const after = await cells();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].key).toBe(before.key);
    expect(after[0].responseStatus).toBe(before.responseStatus);
    expect(after[0].responseBody).toBe(before.responseBody);
    expect(after[0].expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(after[0].createdAt.getTime()).toBe(before.createdAt.getTime());

    // (c) no write landed on either record: one row from the first request and
    // nothing since, on either side.
    expect(handlerRuns).toBe(1);
    const rows = await getPrismaClient().measurement.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(owner.id);
  });

  it("FENCE-AC-05 POSITIVE CONTROL: the same replay under a matching context returns the cached body", async () => {
    // Without this, the assertions above would pass for a wrapper that had
    // stopped replaying anything at all.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await writeGrant(owner.id, delegate.id);
    const session = await signIn(delegate.id);

    const inRecord = await switchOutOfBand(session.id, owner.id);
    assertContext(inRecord, owner.id);

    const first = await post();
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const replay = await post();
    const replayBody = await replay.json();

    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(replayBody.data.id).toBe(firstBody.data.id);
    // Replayed, not re-run.
    expect(handlerRuns).toBe(1);
    expect(await getPrismaClient().measurement.findMany()).toHaveLength(1);
  });

  it("FENCE-AC-05 leaves a never-switched idempotent write byte-identical", async () => {
    // No fence header at all, no switch ever. This is the shape every existing
    // own-record idempotency contract has, and it must not have moved.
    const solo = await makeUser("solo");
    await signIn(solo.id);

    const first = await post();
    expect(first.status).toBe(201);
    const replay = await post();

    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(handlerRuns).toBe(1);
    const stored = await cells();
    expect(stored).toHaveLength(1);
    // The un-delegated cell files under the client's key verbatim — the record
    // fold does not touch a request that is nobody's delegate.
    expect(stored[0].key).toBe(KEY);
  });

  it("FENCE-AC-05 lets a pre-fence bundle reach the route's own refusal", async () => {
    // An `unfenced-client` verdict is not the wrapper's to refuse: the route
    // owns the 403 that bundle recovers from.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await writeGrant(owner.id, delegate.id);
    const session = await signIn(delegate.id);
    await switchOutOfBand(session.id, owner.id);
    // No fence headers at all.

    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).meta.errorCode).toBe("sharing.access.denied");
    expect(handlerRuns).toBe(0);
    expect(await getPrismaClient().measurement.findMany()).toHaveLength(0);
  });
});
