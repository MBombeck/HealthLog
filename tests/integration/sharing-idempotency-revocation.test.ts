/**
 * A delegated replay must still be authorised when the cache has a body.
 *
 * These cases use the shipped idempotency wrapper, bearer selector and grant
 * state machine against Postgres. The small handler keeps the assertion at the
 * cache boundary: the route body counts mutations, while `requireRecordAuth`
 * supplies the same switched-record admission that delegable routes use.
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
import { SECURITY_PRINCIPALS } from "../fixtures/v137/security-principals";

const KEY = "delegated-replay-0f3a1c9d";
let tokenNumber = 0;
let handlerRuns = 0;

async function createUser(id: string) {
  return getPrismaClient().user.create({
    data: {
      id,
      username: `replay-${id}`,
      email: `replay-${id}@example.test`,
      role: "USER",
    },
  });
}

async function mintToken(userId: string): Promise<string> {
  const raw = `hlk_replay_${tokenNumber++}`.padEnd(24, "0");
  await getPrismaClient().apiToken.create({
    data: {
      userId,
      name: "sharing-replay-test",
      tokenHash: hashToken(raw),
      permissions: ["*"],
    },
  });
  return raw;
}

async function mintSession(userId: string): Promise<void> {
  const session = await getPrismaClient().session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function createWriteGrant(input: {
  id: string;
  grantorId: string;
  granteeId: string;
}) {
  return getPrismaClient().accountGrant.create({
    data: {
      id: input.id,
      grantorId: input.grantorId,
      granteeId: input.granteeId,
      access: "WRITE",
      acceptedAt: new Date(Date.now() - 60_000),
    },
  });
}

const delegatedWrite: (request: NextRequest) => Promise<Response> = apiHandler(
  withIdempotency<[NextRequest]>(async () => {
    const { user } = await requireRecordAuth("write", "measurements");
    handlerRuns += 1;
    const row = await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 70 + handlerRuns,
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

function post(key = KEY): Promise<Response> {
  return delegatedWrite(
    new NextRequest("http://localhost/api/test/sharing-idempotency", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ ok: true }),
    }),
  );
}

function actAs(recordUserId: string | null): void {
  if (recordUserId === null) headerJar.delete(ACCOUNT_SELECTOR_HEADER);
  else headerJar.set(ACCOUNT_SELECTOR_HEADER, recordUserId);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  handlerRuns = 0;
  tokenNumber = 0;
});

describe("delegated idempotency replay", () => {
  it("[J5-revoked-idempotent-replay] replays an active delegated retry without a second mutation", async () => {
    const principal = SECURITY_PRINCIPALS.activeDelegation;
    await createUser(principal.identities.actorUserId);
    await createUser(principal.identities.recordUserId);
    await createWriteGrant({
      id: principal.grant.id!,
      grantorId: principal.identities.recordUserId,
      granteeId: principal.identities.actorUserId,
    });
    headerJar.set(
      "authorization",
      `Bearer ${await mintToken(principal.identities.actorUserId)}`,
    );
    actAs(principal.identities.recordUserId);

    const first = await post();
    const firstBody = await first.json();
    const replay = await post();

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    expect(handlerRuns).toBe(1);
    expect(
      await getPrismaClient().measurement.count({
        where: { userId: principal.identities.recordUserId },
      }),
    ).toBe(1);
  });

  it("[J5-revoked-idempotent-replay] refuses a revoked delegated retry without returning the cached DTO", async () => {
    const principal = SECURITY_PRINCIPALS.revokedDelegation;
    await createUser(principal.identities.actorUserId);
    await createUser(principal.identities.recordUserId);
    const grant = await createWriteGrant({
      id: principal.grant.id!,
      grantorId: principal.identities.recordUserId,
      granteeId: principal.identities.actorUserId,
    });
    headerJar.set(
      "authorization",
      `Bearer ${await mintToken(principal.identities.actorUserId)}`,
    );
    actAs(principal.identities.recordUserId);

    const first = await post();
    const cached = await first.json();
    expect(first.status).toBe(201);

    await getPrismaClient().accountGrant.update({
      where: { id: grant.id },
      data: { revokedAt: new Date(), revokedBy: "GRANTOR" },
    });

    const replay = await post();
    const body = await replay.json();

    expect(replay.status).toBe(403);
    expect(replay.headers.get("X-Idempotent-Replay")).not.toBe("true");
    expect(body.data).toBeNull();
    expect(body).not.toEqual(cached);
    expect(handlerRuns).toBe(1);
    expect(
      await getPrismaClient().measurement.count({
        where: { userId: principal.identities.recordUserId },
      }),
    ).toBe(1);
  });

  it("continues to replay an own-record retry", async () => {
    const principal = SECURITY_PRINCIPALS.ownerIdempotencyPositiveControl;
    await createUser(principal.identities.actorUserId);
    headerJar.set(
      "authorization",
      `Bearer ${await mintToken(principal.identities.actorUserId)}`,
    );
    actAs(null);

    const first = await post();
    const firstBody = await first.json();
    const replay = await post();

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    expect(handlerRuns).toBe(1);
    expect(
      await getPrismaClient().measurement.count({
        where: { userId: principal.identities.recordUserId },
      }),
    ).toBe(1);
  });

  it("does not replay when the cookie transport carries a misplaced selector", async () => {
    const principal = SECURITY_PRINCIPALS.ownerIdempotencyPositiveControl;
    await createUser(principal.identities.actorUserId);
    await mintSession(principal.identities.actorUserId);

    const first = await post();
    expect(first.status).toBe(201);

    headerJar.set(ACCOUNT_SELECTOR_HEADER, "untrusted-record-selector");
    const replay = await post();

    expect(replay.status).toBe(403);
    expect(replay.headers.get("X-Idempotent-Replay")).not.toBe("true");
    expect(handlerRuns).toBe(1);
    expect(
      await getPrismaClient().measurement.count({
        where: { userId: principal.identities.recordUserId },
      }),
    ).toBe(1);
  });
});
