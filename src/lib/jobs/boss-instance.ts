/**
 * Process-local pg-boss access.
 *
 * Worker processes install their fully supervised consumer here. Web-only
 * processes install a lightweight producer so request-time writes can enqueue
 * jobs across the documented split deployment.
 */
import { PgBoss } from "pg-boss";

import { getPgBossPoolMax, getPoolConnectionTimeoutMs } from "@/lib/db";
import { timeZoneSessionOptions } from "@/lib/db-session";
// The slot a start is parked in; `whenBossReady` reads it to know one is
// under way.
import { BOSS_START_KEY } from "@/lib/jobs/boss-ready";

const BOSS_KEY = "__healthlog_pgboss__" as const;
const PRODUCER_START_MAX_ATTEMPTS = 5;
const PRODUCER_RETRY_BASE_DELAY_MS = 250;
const PRODUCER_RETRY_MAX_DELAY_MS = 2_000;

export interface ProducerStartOptions {
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

interface ProducerRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function resolveRetryPolicy(
  options: ProducerStartOptions,
): ProducerRetryPolicy {
  const maxAttempts = Math.max(
    1,
    Math.trunc(options.maxAttempts ?? PRODUCER_START_MAX_ATTEMPTS),
  );
  const baseDelayMs = Math.max(
    0,
    Math.trunc(options.retryBaseDelayMs ?? PRODUCER_RETRY_BASE_DELAY_MS),
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    Math.trunc(options.retryMaxDelayMs ?? PRODUCER_RETRY_MAX_DELAY_MS),
  );
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

function retryDelayMs(
  failedAttempt: number,
  policy: ProducerRetryPolicy,
): number {
  return Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1),
  );
}

export function setGlobalBoss(boss: PgBoss | null): void {
  const globalState = globalThis as Record<string, unknown>;
  if (boss) globalState[BOSS_KEY] = boss;
  else delete globalState[BOSS_KEY];
}

export function getGlobalBoss(): PgBoss | null {
  return ((globalThis as Record<string, unknown>)[BOSS_KEY] as PgBoss) ?? null;
}

function databaseOptions(
  connectionString: string,
  role: "worker" | "producer",
) {
  return {
    connectionString,
    max: getPgBossPoolMax(role),
    connectionTimeoutMillis: getPoolConnectionTimeoutMs(),
    // pg-boss keeps its own tables in `timestamptz`, so its queue math does
    // not depend on the zone; the pin keeps every HealthLog session alike.
    options: timeZoneSessionOptions(),
  } as const;
}

/**
 * The worker's pg-boss. `ownsQueueSchema` is false when the connection does
 * not own the `pgboss` schema, which is how the app's restricted role
 * (`scripts/db-app-role.mjs`) runs: the boot installed and migrated the
 * schema as the owner, so pg-boss neither installs, migrates nor runs the
 * index builds a migration queues (`migrate: false`), and never sends
 * `CREATE SCHEMA IF NOT EXISTS` (`createSchema: false`), which Postgres
 * refuses without the database's CREATE privilege even when the schema is
 * there. With `migrate: false`, pg-boss refuses to start on a schema that is
 * not at its version, rather than run on it.
 */
export function createWorkerBoss(
  connectionString: string,
  options: { ownsQueueSchema?: boolean } = {},
): PgBoss {
  return new PgBoss({
    ...databaseOptions(connectionString, "worker"),
    ...(options.ownsQueueSchema === false
      ? { createSchema: false, migrate: false }
      : {}),
  });
}

function producerOptions(connectionString: string) {
  return {
    ...databaseOptions(connectionString, "producer"),
    migrate: false,
    schedule: false,
    supervise: false,
  } as const;
}

async function startProducerAttempts(
  connectionString: string,
  policy: ProducerRetryPolicy,
): Promise<PgBoss> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const boss = new PgBoss(producerOptions(connectionString));
    let ready = false;
    boss.on("error", (error: unknown) => {
      console.error("[pg-boss-producer] error", error);
      if (ready) superviseProducerReconnect(boss, connectionString, policy);
    });
    try {
      await boss.start();
      ready = true;
      setGlobalBoss(boss);
      return boss;
    } catch (error) {
      lastError = error;
      await boss.stop({ graceful: false }).catch(() => undefined);
      if (attempt < policy.maxAttempts) {
        await wait(retryDelayMs(attempt, policy));
      }
    }
  }
  throw lastError;
}

function superviseProducerReconnect(
  failedBoss: PgBoss,
  connectionString: string,
  policy: ProducerRetryPolicy,
): void {
  const globalState = globalThis as Record<string, unknown>;
  if (getGlobalBoss() !== failedBoss || globalState[BOSS_START_KEY]) return;

  setGlobalBoss(null);
  const reconnecting = (async () => {
    await failedBoss.stop({ graceful: false }).catch(() => undefined);
    for (;;) {
      try {
        return await startProducerAttempts(connectionString, policy);
      } catch (error) {
        console.error("[pg-boss-producer] reconnect batch exhausted", error);
        await wait(policy.maxDelayMs);
      }
    }
  })();
  globalState[BOSS_START_KEY] = reconnecting;
  void reconnecting.finally(() => {
    if (globalState[BOSS_START_KEY] === reconnecting) {
      delete globalState[BOSS_START_KEY];
    }
  });
}

/**
 * Start the web process's send-only pg-boss connection exactly once.
 *
 * `PgBoss.start()` is required to confirm the worker-owned schema exists.
 * Migration, schedules, and pg-boss maintenance stay disabled in web mode;
 * this module only supervises the producer connection itself.
 */
export async function startGlobalBossProducer(
  connectionString: string | null | undefined,
  options: ProducerStartOptions = {},
): Promise<PgBoss | null> {
  if (!connectionString) return null;

  const globalState = globalThis as Record<string, unknown>;
  const existing = getGlobalBoss();
  if (existing) return existing;

  const starting = globalState[BOSS_START_KEY] as
    Promise<PgBoss | null> | undefined;
  if (starting) return starting;

  const startPromise = startProducerAttempts(
    connectionString,
    resolveRetryPolicy(options),
  );
  globalState[BOSS_START_KEY] = startPromise;
  try {
    return await startPromise;
  } finally {
    if (globalState[BOSS_START_KEY] === startPromise) {
      delete globalState[BOSS_START_KEY];
    }
  }
}
