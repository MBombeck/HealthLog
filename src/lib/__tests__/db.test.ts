/**
 * Pool configuration stays unit-tested here so connection ceilings and wait
 * timeouts cannot silently fall back to separate library defaults.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSessionOptions,
  getConnectionBudget,
  pinTimeZoneOnConnect,
  SET_SESSION_TIME_ZONE,
  timeZoneSessionOptions,
  getPgBossPoolMax,
  getPoolConnectionTimeoutMs,
  getPrismaPoolMax,
  getStatementTimeoutMs,
  POOL_IDLE_TIMEOUT_MS,
  prismaPoolConfig,
} from "../db";

describe("per-process database connection budget", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalConnectionLimit = process.env.DB_CONNECTION_LIMIT;
  const originalPoolTimeout = process.env.DB_POOL_TIMEOUT;
  const originalLegacyPoolMax = process.env.DATABASE_POOL_MAX;
  const originalProcessType = process.env.HEALTHLOG_PROCESS_TYPE;

  beforeEach(() => {
    process.env.HEALTHLOG_PROCESS_TYPE = "web";
    process.env.DATABASE_URL =
      "postgresql://healthlog:test@db:5432/healthlog?connection_limit=20&pool_timeout=20";
    delete process.env.DB_CONNECTION_LIMIT;
    delete process.env.DB_POOL_TIMEOUT;
    delete process.env.DATABASE_POOL_MAX;
  });

  afterEach(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("DATABASE_URL", originalDatabaseUrl);
    restore("DB_CONNECTION_LIMIT", originalConnectionLimit);
    restore("DB_POOL_TIMEOUT", originalPoolTimeout);
    restore("DATABASE_POOL_MAX", originalLegacyPoolMax);
    restore("HEALTHLOG_PROCESS_TYPE", originalProcessType);
  });

  it("splits the URL connection_limit across Prisma and pg-boss", () => {
    expect(getConnectionBudget()).toBe(20);
    expect(getPrismaPoolMax()).toBe(18);
    expect(getPgBossPoolMax()).toBe(2);
    expect(getPrismaPoolMax() + getPgBossPoolMax()).toBe(getConnectionBudget());
  });

  it("gives a process that runs the worker four pg-boss connections", () => {
    for (const role of ["all", "worker"]) {
      process.env.HEALTHLOG_PROCESS_TYPE = role;
      expect(getPgBossPoolMax()).toBe(4);
      expect(getPrismaPoolMax()).toBe(16);
    }
    process.env.DB_CONNECTION_LIMIT = "3";
    expect(getPgBossPoolMax()).toBe(2);
    expect(getPrismaPoolMax()).toBe(1);
  });

  it("uses the existing pool_timeout seconds for both pool constructors", () => {
    expect(getPoolConnectionTimeoutMs()).toBe(20_000);
  });

  it("prefers explicit DB_CONNECTION_LIMIT and DB_POOL_TIMEOUT values", () => {
    process.env.DB_CONNECTION_LIMIT = "12";
    process.env.DB_POOL_TIMEOUT = "7";

    expect(getConnectionBudget()).toBe(12);
    expect(getPrismaPoolMax()).toBe(10);
    expect(getPgBossPoolMax()).toBe(2);
    expect(getPoolConnectionTimeoutMs()).toBe(7_000);
  });

  it("keeps DATABASE_POOL_MAX as a backward-compatible explicit override", () => {
    process.env.DATABASE_POOL_MAX = "30";

    expect(getConnectionBudget()).toBe(30);
    expect(getPrismaPoolMax()).toBe(28);
  });
});

// A per-session statement timeout so a single stuck query can't hold a
// pool slot forever and starve every DB-backed route.
describe("getStatementTimeoutMs", () => {
  const originalEnv = process.env.DATABASE_STATEMENT_TIMEOUT_MS;

  beforeEach(() => {
    delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    } else {
      process.env.DATABASE_STATEMENT_TIMEOUT_MS = originalEnv;
    }
  });

  it("defaults to 60000ms when the env var is unset", () => {
    expect(getStatementTimeoutMs()).toBe(60_000);
  });

  it("honours a positive override", () => {
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = "30000";
    expect(getStatementTimeoutMs()).toBe(30_000);
  });

  it("allows 0 to disable the timeout (legacy unbounded behaviour)", () => {
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = "0";
    expect(getStatementTimeoutMs()).toBe(0);
  });

  it("falls back to the default on a malformed or negative value", () => {
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = "not-a-number";
    expect(getStatementTimeoutMs()).toBe(60_000);
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = "-5";
    expect(getStatementTimeoutMs()).toBe(60_000);
  });
});

describe("buildSessionOptions", () => {
  const originalEnv = process.env.DATABASE_STATEMENT_TIMEOUT_MS;
  const originalWorkMem = process.env.DATABASE_WORK_MEM;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    } else {
      process.env.DATABASE_STATEMENT_TIMEOUT_MS = originalEnv;
    }
    if (originalWorkMem === undefined) {
      delete process.env.DATABASE_WORK_MEM;
    } else {
      process.env.DATABASE_WORK_MEM = originalWorkMem;
    }
  });

  it("emits both session timeouts as libpq startup options by default", () => {
    delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    const opts = buildSessionOptions();
    expect(opts).toContain("-c statement_timeout=60000");
    expect(opts).toContain("-c idle_in_transaction_session_timeout=60000");
  });

  // v1.42 — work_mem rides the same startup options, and must survive a
  // disabled timeout: up to v1.41 the whole string was undefined at 0.
  it("keeps work_mem when the timeout is disabled", () => {
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = "0";
    delete process.env.DATABASE_WORK_MEM;
    expect(buildSessionOptions()).toBe(
      "-c work_mem=16MB -c jit=off -c TimeZone=UTC",
    );
  });

  it("sets the default work_mem beside the timeouts", () => {
    delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    delete process.env.DATABASE_WORK_MEM;
    expect(buildSessionOptions()).toBe(
      "-c statement_timeout=60000 -c idle_in_transaction_session_timeout=60000 -c work_mem=16MB -c jit=off -c TimeZone=UTC",
    );
  });

  it("sends no startup options at all when a connection pooler needs that", () => {
    process.env.DATABASE_SESSION_OPTIONS_DISABLED = "true";
    try {
      expect(buildSessionOptions()).toBeUndefined();
      process.env.DATABASE_SESSION_OPTIONS_DISABLED = "0";
      expect(buildSessionOptions()).toContain("-c work_mem=");
    } finally {
      delete process.env.DATABASE_SESSION_OPTIONS_DISABLED;
    }
  });

  it("takes DATABASE_WORK_MEM and refuses a value that would inject a flag", () => {
    process.env.DATABASE_WORK_MEM = "64MB";
    expect(buildSessionOptions()).toContain("-c work_mem=64MB");
    process.env.DATABASE_WORK_MEM = "8MB -c statement_timeout=0";
    expect(buildSessionOptions()).toContain("-c work_mem=16MB");
    expect(buildSessionOptions()).toContain("statement_timeout=60000");
  });
});

// Every session runs in UTC whatever the database default says: the stored
// `timestamp` values are UTC and `now()` reads through the session zone.
describe("session time zone pin", () => {
  afterEach(() => {
    delete process.env.DATABASE_SESSION_OPTIONS_DISABLED;
  });

  it("rides the startup options of every pool", () => {
    expect(buildSessionOptions()).toContain("-c TimeZone=UTC");
    expect(timeZoneSessionOptions()).toBe("-c TimeZone=UTC");
  });

  it("adds no connect hook while the startup options carry the pin", () => {
    const on = vi.fn();
    pinTimeZoneOnConnect({ on } as never);
    expect(on).not.toHaveBeenCalled();
  });

  it("pins by statement on connect when the startup options are off", async () => {
    process.env.DATABASE_SESSION_OPTIONS_DISABLED = "true";
    expect(timeZoneSessionOptions()).toBeUndefined();
    const on = vi.fn();
    pinTimeZoneOnConnect({ on } as never);
    expect(on).toHaveBeenCalledWith("connect", expect.any(Function));
    const query = vi.fn().mockResolvedValue(undefined);
    const hook = on.mock.calls[0][1] as (client: unknown) => void;
    hook({ query });
    expect(query).toHaveBeenCalledWith(SET_SESSION_TIME_ZONE);
    expect(SET_SESSION_TIME_ZONE).toBe("SET TIME ZONE 'UTC'");
  });
});

describe("process-wide Prisma client", () => {
  const globalSlot = globalThis as unknown as { prisma?: unknown };

  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalSlot.prisma;
    vi.resetModules();
  });

  it("shares one client across separate copies of the module in production", async () => {
    // A production build loads this module once per server bundle; each copy
    // must resolve the same client rather than constructing its own.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://healthlog:test@db:5432/healthlog?connection_limit=20",
    );
    delete globalSlot.prisma;

    vi.resetModules();
    const first = (await import("../db")).prisma;
    vi.resetModules();
    const second = (await import("../db")).prisma;

    expect(second).toBe(first);
    expect(globalSlot.prisma).toBe(first);
  });
});

// `pg.Pool` closes an idle connection after 10 s by default, so every app
// open after a pause found an empty pool and opened a fresh server process
// for each read of its burst.
describe("pool idle timeout", () => {
  it("keeps the connections of one burst for the next", () => {
    expect(POOL_IDLE_TIMEOUT_MS).toBe(300_000);
    expect(prismaPoolConfig().idleTimeoutMillis).toBe(POOL_IDLE_TIMEOUT_MS);
  });
});
