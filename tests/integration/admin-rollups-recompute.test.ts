/**
 * `POST /api/admin/rollups/recompute` for one account, against Postgres.
 *
 * The single-account mode exists for the accounts the boot backfill could not
 * finish, which are the large ones. It folds the account in the request, and
 * it must give every statement the same budget the boot job gives it
 * (`ROLLUP_FULL_BACKFILL_STATEMENT_BUDGET_MS`): under the database's ordinary
 * statement limit the yearly fold of such an account times out, which is the
 * very failure the operator is trying to get past. The fold itself runs for
 * real; the wrapper only records what the route handed it.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROLLUP_FULL_BACKFILL_STATEMENT_BUDGET_MS } from "@/lib/rollups/full-backfill";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const folds = vi.hoisted(() => ({
  calls: [] as Array<{ userId: string; statementTimeoutMs?: number }>,
}));

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

vi.mock("@/lib/rollups/full-backfill", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rollups/full-backfill")>();
  return {
    ...actual,
    foldUserRollupHistory: async (
      ...args: Parameters<typeof actual.foldUserRollupHistory>
    ) => {
      folds.calls.push({
        userId: args[0],
        statementTimeoutMs: args[1]?.statementTimeoutMs,
      });
      return actual.foldUserRollupHistory(...args);
    },
  };
});

const ADMIN = "user-admin-recompute";
const TARGET = "user-recompute-target";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  folds.calls.length = 0;
  await prisma.user.createMany({
    data: [
      {
        id: ADMIN,
        username: "admin-recompute",
        email: "admin-recompute@example.test",
        role: "ADMIN",
      },
      {
        id: TARGET,
        username: "recompute-target",
        email: "recompute-target@example.test",
      },
    ],
  });
  const session = await prisma.session.create({
    data: { userId: ADMIN, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  await prisma.measurement.create({
    data: {
      userId: TARGET,
      type: "WEIGHT",
      value: 80,
      unit: "kg",
      source: "MANUAL",
      measuredAt: new Date(Date.now() - 30 * 86_400_000),
    },
  });
});

describe("POST /api/admin/rollups/recompute for one account", () => {
  it("folds it with the boot job's statement budget", async () => {
    const { POST } = await import("@/app/api/admin/rollups/recompute/route");
    const res = await POST(
      new NextRequest("http://localhost/api/admin/rollups/recompute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: TARGET }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { mode: string; rowsUpserted: number };
    };
    expect(body.data.mode).toBe("single");
    expect(body.data.rowsUpserted).toBeGreaterThan(0);

    expect(folds.calls).toEqual([
      {
        userId: TARGET,
        statementTimeoutMs: ROLLUP_FULL_BACKFILL_STATEMENT_BUDGET_MS,
      },
    ]);
  });
});
