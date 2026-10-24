/**
 * The `measurementMirror` walk of `/api/sync/changes`, against Postgres.
 *
 * The walk reads the switched tokens first and then each change stamp's
 * readings by `(ingest_token_id, id)`. The page sequence a client sees must be
 * exactly the one the earlier single query produced, which ordered every
 * token-linked reading by `(token.mirrorChangedAt, measurement.id)` and
 * resumed past `(stamp, id)`. That query is kept below as the reference, and
 * every page of every walk is compared against it: tied stamps across tokens,
 * a watermark inside a tie, soft-deleted rows, another account's token, a
 * token never switched, readings with no token, and page sizes from one row
 * up to the whole set.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { readDomainRows } from "@/lib/sync/changes/read-rows";
import type { SyncCursor } from "@/lib/sync/cursor";

import { makeMeasurement, makeToken, makeUser } from "../kit/factories";
import { countStatements } from "./query-counter";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

interface Wm {
  updatedAtMs: number;
  id: string;
}

/** The single-query walk this replaced, verbatim in its semantics. */
async function referenceWalk(
  userId: string,
  wm: Wm | undefined,
  limit: number,
) {
  const at = wm ? new Date(wm.updatedAtMs) : null;
  return prisma.measurement.findMany({
    where: {
      userId,
      deletedAt: null,
      ingestToken: { mirrorChangedAt: { not: null } },
      ...(at &&
        wm && {
          OR: [
            { ingestToken: { mirrorChangedAt: { gt: at } } },
            {
              AND: [
                { ingestToken: { mirrorChangedAt: at } },
                { id: { gt: wm.id } },
              ],
            },
          ],
        }),
    },
    orderBy: [{ ingestToken: { mirrorChangedAt: "asc" } }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      source: true,
      ingestToken: {
        select: { mirrorToAppleHealth: true, mirrorChangedAt: true },
      },
    },
  });
}

async function walk(userId: string, wm: Wm | undefined, limit: number) {
  const cursor = { v: 2, measurementMirror: wm } as unknown as SyncCursor;
  const rows = await readDomainRows(userId, cursor, limit, false);
  return rows.measurementMirror;
}

/** Page through both walks from `start`, asserting each page is identical. */
async function pageThrough(userId: string, limit: number, start?: Wm) {
  let wm = start;
  const seen: string[] = [];
  for (let guard = 0; guard < 200; guard += 1) {
    const [actual, expected] = await Promise.all([
      walk(userId, wm, limit),
      referenceWalk(userId, wm, limit),
    ]);
    expect(actual, `limit ${limit}, page ${guard}`).toEqual(expected);
    const page = actual.slice(0, limit);
    seen.push(...page.map((r) => r.id));
    if (actual.length <= limit) return { seen, wm };
    const last = page[page.length - 1];
    wm = {
      updatedAtMs: last.ingestToken!.mirrorChangedAt!.getTime(),
      id: last.id,
    };
  }
  throw new Error("walk did not terminate");
}

let userId: string;
let otherId: string;
const T0 = new Date("2026-10-01T08:00:00.000Z");
const T1 = new Date("2026-10-02T08:00:00.000Z");
const T2 = new Date("2026-10-03T08:00:00.000Z");

async function rowsFor(
  owner: { id: string },
  tokenId: string | null,
  n: number,
  base: number,
  deleted: number[] = [],
) {
  for (let i = 0; i < n; i += 1) {
    await makeMeasurement(owner, {
      type: "WEIGHT",
      unit: "kg",
      value: 80 + i / 10,
      source: "EXTERNAL",
      measuredAt: new Date(Date.UTC(2026, 8, 1, 0, base + i)),
      ingestTokenId: tokenId,
      deletedAt: deleted.includes(i) ? new Date() : null,
    });
  }
}

async function stamp(tokenId: string, at: Date, on = true) {
  await prisma.apiToken.update({
    where: { id: tokenId },
    data: { mirrorChangedAt: at, mirrorToAppleHealth: on },
  });
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "UTC" });
  const other = await makeUser({ timezone: "UTC" });
  userId = user.id;
  otherId = other.id;
  const [a, b, c, d, never, othersOwn] = await Promise.all([
    makeToken(user, { name: "A" }),
    makeToken(user, { name: "B" }),
    makeToken(user, { name: "C" }),
    makeToken(user, { name: "D" }),
    makeToken(user, { name: "never" }),
    makeToken(other, { name: "others-own" }),
  ]);
  await rowsFor(user, a.tokenId, 7, 0, [3]);
  await rowsFor(user, b.tokenId, 5, 100, [0]);
  await rowsFor(user, c.tokenId, 3, 200);
  await rowsFor(user, never.tokenId, 3, 300);
  await rowsFor(user, d.tokenId, 2, 400);
  await rowsFor(other, othersOwn.tokenId, 3, 600);
  await rowsFor(user, null, 4, 700);
  // A and B share a stamp, so their rows interleave by id.
  await stamp(a.tokenId, T0);
  await stamp(b.tokenId, T0, false);
  await stamp(c.tokenId, T1);
  await stamp(d.tokenId, T2);
  await stamp(othersOwn.tokenId, T1);
});

describe("the measurementMirror walk", () => {
  it.each([1, 2, 3, 5, 8, 100])(
    "pages exactly as the single query did, %i rows a page",
    async (limit) => {
      const { seen } = await pageThrough(userId, limit);
      // 6 + 4 live rows on the tied stamp, 3 on C, 2 on D. Nothing from the
      // never-switched token, nothing of the other account's, nothing
      // deleted, nothing without a token.
      expect(seen).toHaveLength(15);
      expect(new Set(seen).size).toBe(15);
    },
  );

  it("resumes inside a tied stamp, and re-delivers a token switched again", async () => {
    const all = await walk(userId, undefined, 100);
    const tied = all.filter(
      (r) => r.ingestToken!.mirrorChangedAt!.getTime() === T0.getTime(),
    );
    // Both tied tokens' rows interleave by id, so a watermark three rows into
    // the tie leaves rows of both still to come.
    await pageThrough(userId, 2, { updatedAtMs: T0.getTime(), id: tied[2].id });

    const last = all[all.length - 1];
    const caughtUp: Wm = {
      updatedAtMs: last.ingestToken!.mirrorChangedAt!.getTime(),
      id: last.id,
    };
    expect(await walk(userId, caughtUp, 100)).toEqual([]);

    const c = await prisma.apiToken.findFirstOrThrow({
      where: { userId, name: "C" },
    });
    await stamp(c.id, new Date("2026-10-04T08:00:00.000Z"), false);
    const { seen } = await pageThrough(userId, 2, caughtUp);
    expect(seen).toHaveLength(3);
  });

  it("answers a poll with nothing switched past its watermark from the token table alone", async () => {
    const wm = { updatedAtMs: T2.getTime() + 1, id: "" };
    const measured = await countStatements(() => walk(userId, wm, 100));
    expect(measured.result).toEqual([]);
    // The walk's reading-side shape: id, source and the token link.
    const readingWalks = measured.statements.filter((s) =>
      s.startsWith(
        'SELECT "public"."measurements"."id", "public"."measurements"."source"::text, "public"."measurements"."ingest_token_id"',
      ),
    );
    expect(readingWalks).toEqual([]);
    const tokenLookups = measured.statements.filter((s) =>
      s.includes('"public"."api_tokens"."mirror_changed_at" FROM'),
    );
    expect(tokenLookups).toHaveLength(1);
  });

  it("leaves the other account's walk to the other account", async () => {
    const { seen } = await pageThrough(otherId, 2);
    expect(seen).toHaveLength(3);
  });
});
