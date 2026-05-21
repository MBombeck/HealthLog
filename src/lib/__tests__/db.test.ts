/**
 * v1.4.40 W-POOL — pool-config contract for `src/lib/db.ts`.
 *
 * The v1.4.39 empirical cold-mount trace
 * (`.planning/round-v1439-empirical-trace.md` § B2) traced the
 * Wave-B/C dashboard-query stall to the Prisma `pg.Pool` falling
 * back to the library default ceiling of 10 connections. W-POOL
 * pinned the ceiling to 20 via `getPoolMax()`; this test prevents a
 * future refactor from silently dropping the override and re-introducing
 * the saturation regression on a power-user cold mount.
 *
 * The test only exercises the `getPoolMax()` env-resolver. Constructing
 * a real `PrismaClient` requires a live `DATABASE_URL`, which would
 * make this an integration test instead of a unit test — the helper
 * isolation is intentional.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPoolMax } from "../db";

describe("getPoolMax", () => {
  const originalEnv = process.env.DATABASE_POOL_MAX;

  beforeEach(() => {
    delete process.env.DATABASE_POOL_MAX;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DATABASE_POOL_MAX;
    } else {
      process.env.DATABASE_POOL_MAX = originalEnv;
    }
  });

  it("defaults to 20 when DATABASE_POOL_MAX is unset", () => {
    expect(getPoolMax()).toBe(20);
  });

  it("honours DATABASE_POOL_MAX when it parses to a positive int", () => {
    process.env.DATABASE_POOL_MAX = "30";
    expect(getPoolMax()).toBe(30);
  });

  it("falls back to 20 on a malformed DATABASE_POOL_MAX", () => {
    process.env.DATABASE_POOL_MAX = "not-a-number";
    expect(getPoolMax()).toBe(20);
  });

  it("falls back to 20 on a non-positive DATABASE_POOL_MAX", () => {
    process.env.DATABASE_POOL_MAX = "0";
    expect(getPoolMax()).toBe(20);
    process.env.DATABASE_POOL_MAX = "-5";
    expect(getPoolMax()).toBe(20);
  });

  it("never returns the library default of 10 on the happy path", () => {
    // The whole point of the W-POOL change. If anybody removes the
    // `max:` config from `createPrismaClient` and reverts to the
    // library default, this assertion stops the regression before the
    // next saturated cold mount.
    expect(getPoolMax()).toBeGreaterThanOrEqual(20);
  });
});
