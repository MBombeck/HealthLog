/**
 * `GET /api/sync/changes?start=now` (#1339), against Postgres.
 *
 * A client that only wants what changes from now on (the Apple Health
 * write-back) asks for a cursor at the present, then pages forward. The
 * history before that instant must not come back on the measurement walk,
 * and switching a token's write-back on afterwards must still deliver all of
 * that token's readings on `measurementMirror`, because the switch happens
 * after the cursor.
 *
 * The cursor sits a minute behind the present: `updatedAt` is stamped when a
 * write is built, not when it commits, so a row stamped just before the
 * cursor can become visible just after it, and must not be skipped.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET as syncChanges } from "@/app/api/sync/changes/route";
import { PATCH as patchToken } from "@/app/api/tokens/[id]/route";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";

import { callRoute, type RouteAuth } from "../kit/call-route";
import {
  makeMeasurement,
  makeSession,
  makeToken,
  makeUser,
  type BearerFixture,
} from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

interface Block {
  upserts: Array<{ id: string; appleHealthMirror?: boolean }>;
  tombstones: unknown[];
}
interface Page {
  serverNow: string;
  cursor: string | null;
  hasMore: boolean;
  cursorExpired: boolean;
  changes: Record<string, Block>;
}

let userId: string;
let owner: RouteAuth;
let scale: BearerFixture;

beforeEach(async () => {
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "UTC" });
  userId = user.id;
  owner = await makeSession(user);
  scale = await makeToken(user, {
    permissions: [MEASUREMENTS_WRITE_SCOPE],
    name: "Scale",
  });
});

async function pull(query: Record<string, string>) {
  const res = await callRoute<Page>(syncChanges, {
    method: "GET",
    route: "/api/sync/changes",
    query,
    auth: owner,
  });
  expect(res.status).toBe(200);
  return res.data;
}

async function pastMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() <= start + 1) await new Promise((r) => setTimeout(r, 2));
}

describe("a cursor that starts now", () => {
  it("skips the history and pages forward to what changes after it", async () => {
    const old = [];
    for (let i = 0; i < 3; i += 1) {
      old.push(
        await makeMeasurement(
          { id: userId },
          {
            source: "EXTERNAL",
            ingestTokenId: scale.tokenId,
            measuredAt: new Date(Date.UTC(2026, 9, 1 + i, 6)),
            externalId: `old-${i}`,
            // Written well before the cursor's minute of overlap.
            updatedAt: new Date(Date.now() - 120_000),
          },
        ),
      );
    }
    await pastMillisecond();

    const start = await pull({ start: "now" });
    expect(start.hasMore).toBe(false);
    expect(start.cursorExpired).toBe(false);
    expect(start.cursor).toEqual(expect.any(String));
    for (const block of Object.values(start.changes)) {
      expect(block.upserts).toEqual([]);
    }

    // Nothing changed yet: the next page is empty in every domain.
    const quiet = await pull({ cursor: start.cursor! });
    for (const block of Object.values(quiet.changes)) {
      expect(block.upserts).toEqual([]);
      expect(block.tombstones).toEqual([]);
    }

    await pastMillisecond();
    const fresh = await makeMeasurement(
      { id: userId },
      {
        source: "EXTERNAL",
        ingestTokenId: scale.tokenId,
        measuredAt: new Date(Date.UTC(2026, 10, 4, 6)),
        externalId: "fresh",
      },
    );
    const switched = await callRoute(patchToken, {
      method: "PATCH",
      route: "/api/tokens/{id}",
      params: { id: scale.tokenId },
      body: { mirrorToAppleHealth: true },
      auth: owner,
    });
    expect(switched.status).toBe(200);

    const next = await pull({ cursor: start.cursor! });
    expect(next.cursorExpired).toBe(false);
    expect(next.changes.measurements.upserts.map((r) => r.id)).toEqual([
      fresh.id,
    ]);
    const mirrored = next.changes.measurementMirror.upserts;
    expect(mirrored.map((r) => r.id).sort()).toEqual(
      [...old.map((m) => m.id), fresh.id].sort(),
    );
    expect(mirrored.every((r) => r.appleHealthMirror === true)).toBe(true);

    // And the cursor it hands back is a normal one: draining further is quiet.
    const after = await pull({ cursor: next.cursor! });
    expect(after.changes.measurements.upserts).toEqual([]);
    expect(after.changes.measurementMirror.upserts).toEqual([]);
  });

  it("delivers a row stamped before the cursor that commits after it", async () => {
    const start = await pull({ start: "now" });
    // A write in flight when the cursor was handed out: its stamp predates
    // the cursor, its commit does not.
    const late = await makeMeasurement(
      { id: userId },
      {
        source: "EXTERNAL",
        ingestTokenId: scale.tokenId,
        measuredAt: new Date(Date.UTC(2026, 10, 4, 6)),
        externalId: "late",
        updatedAt: new Date(Date.now() - 30_000),
      },
    );
    const next = await pull({ cursor: start.cursor! });
    expect(next.changes.measurements.upserts.map((r) => r.id)).toEqual([
      late.id,
    ]);
  });

  it("refuses start=now beside a cursor", async () => {
    const res = await callRoute(syncChanges, {
      method: "GET",
      route: "/api/sync/changes",
      query: { start: "now", cursor: "abc" },
      auth: owner,
    });
    expect(res.status).toBe(422);
  });
});
